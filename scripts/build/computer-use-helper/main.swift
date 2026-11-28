import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ windowID: UnsafeMutablePointer<CGWindowID>) -> AXError

struct HelperConfig: Decodable {
  let socketPath: String
  let token: String
  let parentPid: Int32
}

struct ObservedWindowBounds: Decodable {
  let x, y, width, height: CGFloat

  func matches(_ rect: CGRect) -> Bool {
    abs(rect.minX - x) <= 1 && abs(rect.minY - y) <= 1
      && abs(rect.width - width) <= 1 && abs(rect.height - height) <= 1
  }
}

struct StageActionInput: Decodable {
  let type: String?
  let action: String?
  let normX: Double?
  let normY: Double?
  let rx: Double?
  let ry: Double?
  let imageWidth: Double?
  let imageHeight: Double?
  let x: Double?
  let y: Double?
  let button: String?
  let double: Bool?
  let clickCount: Int?
  let popupWindowId: Int?
  let popupBounds: ObservedWindowBounds?
  let text: String?
  let clear: Bool?
  let submit: Bool?
  let key: String?
  let keyCode: Int?
  let modifiers: [String]?
  let direction: String?
  let amount: Int?
  let dx: Int?
  let dy: Int?
  let toNormX: Double?
  let toNormY: Double?
  let toRx: Double?
  let toRy: Double?
  let toX: Double?
  let toY: Double?
  let steps: Int?
  let ms: Int?
}

struct HelperRequest: Decodable {
  let token: String?
  let op: String?
  let kind: String?
  let command: String?
  let args: [String]?
  let timeoutMs: Int?
  let windowId: Int?
  let pid: Int?
  let appName: String?
  let bundleId: String?
  let appPath: String?
  let includePopups: Bool?
  let maxEdge: Int?
  let format: String?
  let quality: Double?
  let focus: Bool?
  let teardownIfEmpty: Bool?
  let actions: [StageActionInput]?
  let searchField: Bool?
  let captureAfter: Bool?
  let settleMs: Int?
  let popupWaitMs: Int?
  let restoreFocus: Bool?
}

private let HELPER_NAME = "Pi Studio Computer Use"
private let ALLOWED_COMMANDS: Set<String> = [
  "/usr/bin/osascript",
  "/usr/sbin/screencapture",
]
private let MAX_REQUEST_BYTES = 4 * 1024 * 1024

private var globalSocketPath: String?
private var globalServerFd: Int32 = -1

private func cleanupSocket() {
  if globalServerFd >= 0 {
    close(globalServerFd)
    globalServerFd = -1
  }
  if let path = globalSocketPath {
    unlink(path)
    globalSocketPath = nil
  }
}

private func constantTimeEquals(_ lhs: String, _ rhs: String) -> Bool {
  let a = Array(lhs.utf8)
  let b = Array(rhs.utf8)
  guard a.count == b.count else { return false }
  var diff: UInt8 = 0
  for i in 0..<a.count {
    diff |= a[i] ^ b[i]
  }
  return diff == 0
}

private func bundleMetadata() -> [String: Any] {
  let bundle = Bundle.main
  return [
    "pid": Int(getpid()),
    "helperName": HELPER_NAME,
    "bundleId": bundle.bundleIdentifier ?? "dev.pi.studio.computer-use",
    "bundlePath": bundle.bundlePath,
  ]
}

private func currentPermissionPayload() -> [String: Any] {
  let screenGranted = CGPreflightScreenCaptureAccess()
  let accessibilityGranted = AXIsProcessTrusted()
  var payload = bundleMetadata()
  payload["ok"] = true
  payload["screenRecording"] = screenGranted ? "granted" : "not-determined"
  payload["accessibility"] = accessibilityGranted
  payload["virtualStageSupported"] = VirtualStageManager.isSupported
  return payload
}

private func requestPermissionPayload(kind: String) -> [String: Any] {
  let normalized = kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if normalized == "accessibility" {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
  } else {
    _ = CGRequestScreenCaptureAccess()
  }
  var payload = currentPermissionPayload()
  payload["prompted"] = true
  payload["kind"] = normalized == "accessibility" ? "accessibility" : "screen"
  return payload
}

private func runAllowedCommand(command: String, args: [String], timeoutMs: Int) -> [String: Any] {
  guard ALLOWED_COMMANDS.contains(command) else {
    return [
      "ok": false,
      "code": "helper_command_not_allowed",
      "error": "Command is not allowed in \(HELPER_NAME): \(command)",
    ]
  }

  let clampedTimeoutMs = max(500, min(timeoutMs, 60_000))
  let process = Process()
  process.executableURL = URL(fileURLWithPath: command)
  process.arguments = args

  let stdoutPipe = Pipe()
  let stderrPipe = Pipe()
  process.standardOutput = stdoutPipe
  process.standardError = stderrPipe

  let stdoutLock = NSLock()
  let stderrLock = NSLock()
  var stdoutData = Data()
  var stderrData = Data()

  stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
    let chunk = handle.availableData
    if !chunk.isEmpty {
      stdoutLock.lock()
      stdoutData.append(chunk)
      stdoutLock.unlock()
    }
  }
  stderrPipe.fileHandleForReading.readabilityHandler = { handle in
    let chunk = handle.availableData
    if !chunk.isEmpty {
      stderrLock.lock()
      stderrData.append(chunk)
      stderrLock.unlock()
    }
  }

  let finished = DispatchSemaphore(value: 0)
  process.terminationHandler = { _ in
    finished.signal()
  }

  do {
    try process.run()
  } catch {
    stdoutPipe.fileHandleForReading.readabilityHandler = nil
    stderrPipe.fileHandleForReading.readabilityHandler = nil
    return [
      "ok": false,
      "code": "helper_spawn_failed",
      "error": error.localizedDescription,
    ]
  }

  let waitResult = finished.wait(timeout: .now() + .milliseconds(clampedTimeoutMs))
  var timedOut = false
  if waitResult == .timedOut {
    timedOut = true
    process.terminate()
    _ = finished.wait(timeout: .now() + .milliseconds(500))
    if process.isRunning {
      kill(process.processIdentifier, SIGKILL)
      _ = finished.wait(timeout: .now() + .milliseconds(500))
    }
  }

  stdoutPipe.fileHandleForReading.readabilityHandler = nil
  stderrPipe.fileHandleForReading.readabilityHandler = nil

  let remainingOut = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
  let remainingErr = stderrPipe.fileHandleForReading.readDataToEndOfFile()
  stdoutLock.lock()
  stdoutData.append(remainingOut)
  let outString = String(data: stdoutData, encoding: .utf8) ?? ""
  stdoutLock.unlock()

  stderrLock.lock()
  stderrData.append(remainingErr)
  let errString = String(data: stderrData, encoding: .utf8) ?? ""
  stderrLock.unlock()

  if timedOut {
    return [
      "ok": false,
      "code": "ETIMEDOUT",
      "exitCode": -1,
      "stdout": outString,
      "stderr": errString,
      "error": "Command timed out after \(clampedTimeoutMs)ms",
    ]
  }

  let exitCode = Int(process.terminationStatus)
  if exitCode != 0 {
    return [
      "ok": false,
      "code": "helper_exec_failed",
      "exitCode": exitCode,
      "stdout": outString,
      "stderr": errString,
      "error": errString.isEmpty ? "Command exited with status \(exitCode)" : errString,
    ]
  }

  return [
    "ok": true,
    "exitCode": 0,
    "stdout": outString,
    "stderr": errString,
  ]
}

// MARK: - ScreenCaptureKit Composite Window Capture

private final class CaptureResultBox: @unchecked Sendable {
  private let lock = NSLock()
  private var payload: [String: Any]?

  func set(_ value: [String: Any]) {
    lock.lock()
    payload = value
    lock.unlock()
  }

  func get() -> [String: Any]? {
    lock.lock()
    defer { lock.unlock() }
    return payload
  }
}

private func encodeCGImage(_ image: CGImage, format: String, quality: Double) -> (data: Data, mimeType: String)? {
  let useJpeg = format.lowercased() == "jpeg" || format.lowercased() == "jpg"
  let uti = (useJpeg ? UTType.jpeg.identifier : UTType.png.identifier) as CFString
  let mutableData = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(mutableData, uti, 1, nil) else {
    return nil
  }
  if useJpeg {
    let clampedQ = max(0.3, min(quality, 0.95))
    let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: clampedQ]
    CGImageDestinationAddImage(dest, image, options as CFDictionary)
  } else {
    CGImageDestinationAddImage(dest, image, nil)
  }
  guard CGImageDestinationFinalize(dest) else {
    return nil
  }
  return (mutableData as Data, useJpeg ? "image/jpeg" : "image/png")
}

private func computeScaledSize(rawWidth: Int, rawHeight: Int, maxEdge: Int) -> (width: Int, height: Int, scaled: Bool) {
  let w = max(1, rawWidth)
  let h = max(1, rawHeight)
  guard maxEdge > 0 else { return (w, h, false) }
  let longest = max(w, h)
  guard longest > maxEdge else { return (w, h, false) }
  let ratio = Double(maxEdge) / Double(longest)
  return (
    max(1, Int((Double(w) * ratio).rounded())),
    max(1, Int((Double(h) * ratio).rounded())),
    true
  )
}

@available(macOS 14.0, *)
private func bestDisplay(for rect: CGRect, displays: [SCDisplay]) -> SCDisplay? {
  var best: SCDisplay?
  var bestArea: CGFloat = 0
  for display in displays {
    let inter = display.frame.intersection(rect)
    if !inter.isNull {
      let area = inter.width * inter.height
      if area > bestArea {
        bestArea = area
        best = display
      }
    }
  }
  if let found = best { return found }
  let center = CGPoint(x: rect.midX, y: rect.midY)
  return displays.first(where: { $0.frame.contains(center) })
}

// WindowServer returns front-to-back order. Only consider visible panels above the
// bound main window, owned by the same process and attached to its screen area.
private func popupFrames(above mainId: CGWindowID, owner: pid_t, mainFrame: CGRect) -> [(id: CGWindowID, frame: CGRect)] {
  guard owner > 0,
        let rows = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow, .excludeDesktopElements], mainId) as? [[String: Any]] else { return [] }
  var frames: [(id: CGWindowID, frame: CGRect)] = []
  for row in rows {
    guard (row[kCGWindowOwnerPID as String] as? pid_t) == owner,
          let id = row[kCGWindowNumber as String] as? CGWindowID,
          (row[kCGWindowAlpha as String] as? Double ?? 1) > 0.01,
          (row[kCGWindowSharingState as String] as? Int) != 0,
          let bounds = row[kCGWindowBounds as String] as? NSDictionary,
          let frame = CGRect(dictionaryRepresentation: bounds),
          frame.width >= 16, frame.height >= 16,
          mainFrame.insetBy(dx: -8, dy: -8).intersects(frame) else { continue }
    let layer = row[kCGWindowLayer as String] as? Int ?? 0
    let title = (row[kCGWindowName as String] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    // A borderless Qt dropdown can be taller than a short chat window.
    if (layer > 0 && layer < 1000) || (layer == 0 && title.isEmpty && frame.width <= mainFrame.width && frame != mainFrame) {
      frames.append((id, frame))
    }
  }
  return frames
}

// Read only items exposed by the expanded, focused control in the bound window.
// Custom-drawn search lists often expose neither an expanded state nor AX items.
private func expandedSearchOptions(pid: pid_t, windowId: CGWindowID) -> [String] {
  let app = AXUIElementCreateApplication(pid)
  func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    AXUIElementSetMessagingTimeout(element, 0.06)
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
  }
  guard let focused = attribute(app, kAXFocusedUIElementAttribute),
        CFGetTypeID(focused) == AXUIElementGetTypeID() else { return [] }
  let field = focused as! AXUIElement
  var id: CGWindowID = 0
  guard _AXUIElementGetWindow(field, &id) == .success, id == windowId,
        [kAXComboBoxRole, kAXTextFieldRole].contains(attribute(field, kAXRoleAttribute) as? String ?? ""),
        attribute(field, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole,
        attribute(field, kAXExpandedAttribute) as? Bool == true else { return [] }
  func children(_ parent: AXUIElement, _ key: String) -> [AXUIElement] {
    var array: CFArray?
    AXUIElementSetMessagingTimeout(parent, 0.06)
    guard AXUIElementCopyAttributeValues(parent, key as CFString, 0, 12, &array) == .success else { return [] }
    return array as? [AXUIElement] ?? []
  }
  let containers = children(field, kAXChildrenAttribute) + children(field, kAXLinkedUIElementsAttribute)
  for list in containers {
    var owner: pid_t = 0
    guard AXUIElementGetPid(list, &owner) == .success, owner == pid,
          _AXUIElementGetWindow(list, &id) == .success, id == windowId,
          [kAXListRole, kAXMenuRole].contains(attribute(list, kAXRoleAttribute) as? String ?? "") else { continue }
    let names = children(list, kAXVisibleChildrenAttribute).compactMap { item -> String? in
      guard [kAXRowRole, kAXMenuItemRole, kAXStaticTextRole].contains(attribute(item, kAXRoleAttribute) as? String ?? "") else { return nil }
      let label = (attribute(item, kAXTitleAttribute) as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      return label.isEmpty ? nil : String(label.prefix(120))
    }
    if !names.isEmpty { return names }
  }
  return []
}

@available(macOS 14.0, *)
private func captureWindowSCKAsync(
  windowId: Int,
  includePopups: Bool,
  maxEdge: Int,
  format: String,
  quality: Double,
  popupWaitMs: Int
) async -> [String: Any] {
  do {
    var searchOptions: [String] = []
    if includePopups, popupWaitMs > 0,
       let id = CGWindowID(exactly: windowId),
       let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]],
       let row = rows.first, row[kCGWindowIsOnscreen as String] as? Bool == true,
       let pid = row[kCGWindowOwnerPID as String] as? pid_t,
       let bounds = row[kCGWindowBounds as String] as? NSDictionary,
       let frame = CGRect(dictionaryRepresentation: bounds) {
      let deadline = ProcessInfo.processInfo.systemUptime + Double(min(popupWaitMs, 3000)) / 1000
      repeat {
        if !popupFrames(above: id, owner: pid, mainFrame: frame).isEmpty { break }
        searchOptions = expandedSearchOptions(pid: pid, windowId: id)
        if !searchOptions.isEmpty || ProcessInfo.processInfo.systemUptime >= deadline { break }
        try await Task.sleep(nanoseconds: 60_000_000)
      } while true
    }
    // Take the shareable-window inventory after waiting, so it includes the new panel.
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let targetWindow = content.windows.first(where: { Int($0.windowID) == windowId }) else {
      return [
        "ok": false,
        "code": "sc_window_not_found",
        "error": "ScreenCaptureKit could not find window \(windowId)",
      ]
    }

    let targetFrame = targetWindow.frame
    let pid = targetWindow.owningApplication?.processID ?? 0

    func captureSingleWindow(_ window: SCWindow) async throws -> (CGImage, Bool, CGRect) {
      let targetFrame = window.frame
      let filter = SCContentFilter(desktopIndependentWindow: window)
      let scale = CGFloat(max(1.0, filter.pointPixelScale))
      let rawW = max(1, Int((targetFrame.width * scale).rounded()))
      let rawH = max(1, Int((targetFrame.height * scale).rounded()))
      let sized = computeScaledSize(rawWidth: rawW, rawHeight: rawH, maxEdge: maxEdge)
      let config = SCStreamConfiguration()
      config.width = sized.width
      config.height = sized.height
      config.showsCursor = false
      config.scalesToFit = true
      config.ignoreShadowsSingleWindow = true
      config.captureResolution = .best
      let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
      return (image, sized.scaled, targetFrame)
    }

    var capturedImage: CGImage?
    var wasScaled = false
    var overlayCount = 0
    var captureMode = "sck_single_window"
    var capturedBounds = targetFrame
    var panels: [[String: Any]] = []
    var popupRegions: [[String: Any]] = []

    if includePopups,
       targetWindow.isOnScreen,
       targetFrame.width >= 20,
       targetFrame.height >= 20,
       let display = bestDisplay(for: targetFrame, displays: content.displays) {
      let frames = popupFrames(above: targetWindow.windowID, owner: pid, mainFrame: targetFrame)
      let overlayWindows = frames.compactMap { surface in
        content.windows.first { $0.windowID == surface.id && $0.isOnScreen && $0.owningApplication?.processID == pid }
      }

      func captureRegion(_ frame: CGRect, including included: [SCWindow], includeChildren: Bool) async throws -> (CGImage, Bool) {
        let sourceRect = frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
        let filter = SCContentFilter(display: display, including: included)
        let scale = CGFloat(max(1.0, filter.pointPixelScale))
        let rawW = max(1, Int((sourceRect.width * scale).rounded()))
        let rawH = max(1, Int((sourceRect.height * scale).rounded()))
        let sized = computeScaledSize(rawWidth: rawW, rawHeight: rawH, maxEdge: maxEdge)
        let config = SCStreamConfiguration()
        config.sourceRect = sourceRect
        if #available(macOS 14.2, *) { config.includeChildWindows = includeChildren }
        config.width = sized.width
        config.height = sized.height
        config.showsCursor = false
        config.scalesToFit = true
        config.captureResolution = .best
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        return (image, sized.scaled)
      }

      if display.frame.contains(targetFrame) {
        do {
          let (image, scaled) = try await captureRegion(targetFrame, including: [targetWindow] + overlayWindows, includeChildren: true)
          capturedImage = image
          wasScaled = scaled
          overlayCount = overlayWindows.count
          captureMode = "sck_display_composite"
        } catch {
          // Fall back to desktop-independent single-window capture if display-bound filter fails (e.g. Stage Manager).
          let single = try await captureSingleWindow(targetWindow)
          capturedImage = single.0
          wasScaled = single.1
          capturedBounds = single.2
          captureMode = "sck_single_window_fallback"
        }
      }
      if captureMode == "sck_display_composite" {
        popupRegions = overlayWindows.filter { targetFrame.intersects($0.frame) }.map { popup in
          let frame = popup.frame
          return ["windowId": Int(popup.windowID),
                  "bounds": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]]
        }
      }
      // Keep the main image in its original coordinate system. Capture the rest
      // of a protruding panel as a separate image with its own clickable window ID.
      for panel in overlayWindows.filter({ capturedImage == nil || captureMode != "sck_display_composite" || !targetFrame.contains($0.frame) }).prefix(3) {
        let image: CGImage?
        if display.frame.contains(panel.frame) {
          image = try? await captureRegion(panel.frame, including: [panel], includeChildren: false).0
        } else {
          image = try? await captureSingleWindow(panel).0
        }
        guard let image, let bytes = encodeCGImage(image, format: format, quality: quality) else { continue }
        panels.append([
          "windowId": Int(panel.windowID), "mimeType": bytes.mimeType, "data": bytes.data.base64EncodedString(),
          "imageWidth": image.width, "imageHeight": image.height,
          "bounds": ["x": panel.frame.minX, "y": panel.frame.minY, "width": panel.frame.width, "height": panel.frame.height],
        ])
      }
    }

    if capturedImage == nil {
      let single = try await captureSingleWindow(targetWindow)
      capturedImage = single.0
      wasScaled = single.1
      capturedBounds = single.2
    }

    guard let image = capturedImage,
          let encoded = encodeCGImage(image, format: format, quality: quality) else {
      return [
        "ok": false,
        "code": "sc_encode_failed",
        "error": "Failed to encode captured window image",
      ]
    }

    return [
      "ok": true,
      "mimeType": encoded.mimeType,
      "data": encoded.data.base64EncodedString(),
      "imageWidth": image.width,
      "imageHeight": image.height,
      "bytes": encoded.data.count,
      "scaled": wasScaled,
      "overlayCount": max(overlayCount, panels.count),
      "accessibilityOptions": searchOptions,
      "panels": panels,
      "popupRegions": popupRegions,
      "captureMode": captureMode,
      "bounds": [
        "x": Double(capturedBounds.origin.x),
        "y": Double(capturedBounds.origin.y),
        "width": Double(capturedBounds.width),
        "height": Double(capturedBounds.height),
      ],
    ]
  } catch {
    return [
      "ok": false,
      "code": "sc_capture_failed",
      "error": error.localizedDescription,
    ]
  }
}

private func captureWindowPayload(
  windowId: Int,
  includePopups: Bool,
  maxEdge: Int,
  format: String,
  quality: Double,
  timeoutMs: Int,
  popupWaitMs: Int = 0
) -> [String: Any] {
  guard windowId > 0 else {
    return [
      "ok": false,
      "code": "invalid_window_id",
      "error": "windowId must be a positive integer",
    ]
  }
  guard #available(macOS 14.0, *) else {
    return [
      "ok": false,
      "code": "sc_unsupported_os",
      "error": "ScreenCaptureKit screenshot capture requires macOS 14+",
    ]
  }
  guard CGPreflightScreenCaptureAccess() else {
    return ["ok": false, "code": "desktop_screen_permission", "error": "请在系统设置中允许 Pi Studio Computer Use 录制屏幕。"]
  }
  let clampedTimeoutMs = max(1000, min(timeoutMs, 20_000))
  let semaphore = DispatchSemaphore(value: 0)
  let box = CaptureResultBox()
  Task {
    let result = await captureWindowSCKAsync(
      windowId: windowId,
      includePopups: includePopups,
      maxEdge: maxEdge,
      format: format,
      quality: quality,
      popupWaitMs: popupWaitMs
    )
    box.set(result)
    semaphore.signal()
  }
  let waitResult = semaphore.wait(timeout: .now() + .milliseconds(clampedTimeoutMs))
  if waitResult == .timedOut {
    return [
      "ok": false,
      "code": "ETIMEDOUT",
      "error": "ScreenCaptureKit capture timed out after \(clampedTimeoutMs)ms",
    ]
  }
  return box.get() ?? [
    "ok": false,
    "code": "sc_empty_result",
    "error": "ScreenCaptureKit returned no result",
  ]
}

// MARK: - Virtual Stage (CGVirtualDisplay + Atomic Background Execution)

private typealias InitModeIMP = @convention(c) (AnyObject, Selector, UInt32, UInt32, Double) -> Unmanaged<AnyObject>?
private typealias ApplySettingsIMP = @convention(c) (AnyObject, Selector, AnyObject) -> Bool

private struct StagedWindowRecord {
  let windowId: Int
  let pid: Int32
  let window: AXUIElement
  let bundleId: String
  let appName: String
  let originalBounds: CGRect
  var stagedBounds: CGRect
  let stagedAt: TimeInterval
  var releasePending = false
}

private let NAMED_KEY_CODES: [String: UInt16] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49,
  "escape": 53, "esc": 53, "delete": 51, "backspace": 51,
  "forwarddelete": 117, "left": 123, "right": 124, "down": 125, "up": 126,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
  "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
  "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
  "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
  ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
]

private final class VirtualStageManager {
  static let shared = VirtualStageManager()

  static var isSupported: Bool {
    guard #available(macOS 14.0, *) else { return false }
    return NSClassFromString("CGVirtualDisplayDescriptor") != nil
      && NSClassFromString("CGVirtualDisplay") != nil
      && NSClassFromString("CGVirtualDisplaySettings") != nil
      && NSClassFromString("CGVirtualDisplayMode") != nil
  }

  private let stageQueue = DispatchQueue(label: "dev.pi.studio.computer-use.virtual-stage")
  private var virtualDisplay: NSObject?
  private var displayID: CGDirectDisplayID = 0
  private var displayBounds: CGRect = .zero
  private var stagedWindows: [Int: StagedWindowRecord] = [:]
  private var recentWindows: [(id:Int, app:NSRunningApplication, handle:AXUIElement)] = []

  private func pumpMainRunLoop(_ seconds: TimeInterval) {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: max(0.005, seconds)))
  }

  private func rectToDict(_ r: CGRect) -> [String: Any] {
    [
      "x": Double(r.origin.x),
      "y": Double(r.origin.y),
      "width": Double(r.size.width),
      "height": Double(r.size.height),
    ]
  }

  private func physicalDisplayBoundsExcludingStage() -> [CGRect] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    var count: UInt32 = 0
    CGGetActiveDisplayList(16, &ids, &count)
    var out: [CGRect] = []
    for i in 0..<Int(count) {
      let id = ids[i]
      if id == displayID || (CGDisplayVendorNumber(id) == 0x5354 && CGDisplayModelNumber(id) == 0x5049) { continue }
      out.append(CGDisplayBounds(id))
    }
    return out
  }

  private func ensureDisplayOnMain() -> (displayID: CGDirectDisplayID, bounds: CGRect)? {
    if virtualDisplay != nil && displayID != 0 && CGDisplayIsActive(displayID) != 0 {
      displayBounds = CGDisplayBounds(displayID)
      if displayBounds.width >= 320 && displayBounds.height >= 240 {
        return (displayID, displayBounds)
      }
    }

    guard Self.isSupported,
          let descClass = NSClassFromString("CGVirtualDisplayDescriptor") as? NSObject.Type,
          let dispClass = NSClassFromString("CGVirtualDisplay") as? NSObject.Type,
          let settingsClass = NSClassFromString("CGVirtualDisplaySettings") as? NSObject.Type,
          let modeClass = NSClassFromString("CGVirtualDisplayMode") as? NSObject.Type else {
      return nil
    }

    let physical = physicalDisplayBoundsExcludingStage()
    var maxX: CGFloat = 1920
    var maxY: CGFloat = 1080
    if !physical.isEmpty {
      maxX = physical.map { $0.maxX }.max() ?? 1920
      maxY = physical.map { $0.maxY }.max() ?? 1080
    }

    let desc = descClass.init()
    desc.setValue("Pi Studio Stage", forKey: "name")
    desc.setValue(NSNumber(value: 3840), forKey: "maxPixelsWide")
    desc.setValue(NSNumber(value: 2160), forKey: "maxPixelsHigh")
    desc.setValue(NSValue(size: NSSize(width: 527, height: 296)), forKey: "sizeInMillimeters")
    desc.setValue(NSNumber(value: 0x5049), forKey: "productID")
    desc.setValue(NSNumber(value: 0x5354), forKey: "vendorID")
    // WindowServer rejects a second virtual display with the same vendor/product/serial,
    // including during a dev restart while the previous helper is releasing its display.
    var online = [CGDirectDisplayID](repeating: 0, count: 64)
    var count: UInt32 = 0
    guard CGGetOnlineDisplayList(UInt32(online.count), &online, &count) == .success else { return nil }
    let occupied = Set(online.prefix(Int(count)).filter {
      CGDisplayVendorNumber($0) == 0x5354 && CGDisplayModelNumber($0) == 0x5049
    }.map { CGDisplaySerialNumber($0) })
    var serial: UInt32 = 1
    while occupied.contains(serial) { serial += 1 }
    desc.setValue(NSNumber(value: serial), forKey: "serialNum")
    desc.setValue(DispatchQueue.main, forKey: "queue")

    guard let allocDisp = dispClass.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue(),
          let disp = allocDisp.perform(NSSelectorFromString("initWithDescriptor:"), with: desc)?.takeRetainedValue() as? NSObject else {
      return nil
    }

    let modeSel = NSSelectorFromString("initWithWidth:height:refreshRate:")
    let modeImp = unsafeBitCast(class_getMethodImplementation(modeClass, modeSel), to: InitModeIMP.self)
    guard let allocMode = modeClass.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue(),
          let mode = modeImp(allocMode, modeSel, 1920, 1080, 60.0)?.takeRetainedValue() else {
      return nil
    }

    let settings = settingsClass.init()
    settings.setValue(NSNumber(value: 1), forKey: "hiDPI")
    settings.setValue([mode], forKey: "modes")

    let applySel = NSSelectorFromString("applySettings:")
    let applyImp = unsafeBitCast(class_getMethodImplementation(dispClass, applySel), to: ApplySettingsIMP.self)
    guard applyImp(disp, applySel, settings) else {
      return nil
    }

    let newID = (disp.value(forKey: "displayID") as? NSNumber)?.uint32Value ?? 0
    guard newID != 0 else { return nil }

    virtualDisplay = disp
    displayID = newID
    pumpMainRunLoop(0.35)

    // Position the virtual display diagonally outside all physical screens so the user's cursor never strays into it.
    var cfg: CGDisplayConfigRef?
    if CGBeginDisplayConfiguration(&cfg) == .success, let configRef = cfg {
      CGConfigureDisplayOrigin(configRef, newID, Int32(maxX), Int32(maxY))
      CGCompleteDisplayConfiguration(configRef, .forAppOnly)
      pumpMainRunLoop(0.25)
    }

    displayBounds = CGDisplayBounds(newID)
    return (newID, displayBounds)
  }

  private func resolveRunningApp(pid: Int32?, bundleId: String?, appName: String?, appPath: String?) -> NSRunningApplication? {
    if let p = pid, p > 0, let app = NSRunningApplication(processIdentifier: p) {
      return app
    }
    let wantBundle = (bundleId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let wantPath = (appPath ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let wantName = (appName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    for app in NSWorkspace.shared.runningApplications {
      let b = (app.bundleIdentifier ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      let p = (app.bundleURL?.path ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      let n = (app.localizedName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      let execName = (app.executableURL?.lastPathComponent ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      if !wantBundle.isEmpty && b == wantBundle { return app }
      if !wantPath.isEmpty && p == wantPath { return app }
      if wantBundle.isEmpty && wantPath.isEmpty && !wantName.isEmpty && (n == wantName || execName == wantName) {
        return app
      }
    }
    return nil
  }

  private func cgWindowInfo(windowId: Int) -> (pid: Int32, bounds: CGRect, onscreen: Bool, alpha: Double, title: String, shareable: Bool)? {
    guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
      return nil
    }
    for row in list {
      guard let wid = row[kCGWindowNumber as String] as? Int, wid == windowId else { continue }
      let pid = (row[kCGWindowOwnerPID as String] as? Int32) ?? 0
      let onscreen = (row[kCGWindowIsOnscreen as String] as? Bool) ?? false
      let alpha = (row[kCGWindowAlpha as String] as? Double) ?? 1.0
      let title = (row[kCGWindowName as String] as? String) ?? ""
      let b = row[kCGWindowBounds as String] as? [String: Any] ?? [:]
      let rect = CGRect(
        x: (b["X"] as? CGFloat) ?? CGFloat((b["X"] as? Double) ?? 0),
        y: (b["Y"] as? CGFloat) ?? CGFloat((b["Y"] as? Double) ?? 0),
        width: (b["Width"] as? CGFloat) ?? CGFloat((b["Width"] as? Double) ?? 0),
        height: (b["Height"] as? CGFloat) ?? CGFloat((b["Height"] as? Double) ?? 0)
      )
      return (pid,rect,onscreen,alpha,title,(row[kCGWindowSharingState as String] as? Int ?? 0) != 0)
    }
    return nil
  }

  private func axWindowPosition(_ win: AXUIElement) -> CGPoint? {
    var val: CFTypeRef?
    guard AXUIElementCopyAttributeValue(win, kAXPositionAttribute as CFString, &val) == .success, let v = val else {
      return nil
    }
    var pt = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &pt) ? pt : nil
  }

  private func axWindowSize(_ win: AXUIElement) -> CGSize? {
    var val: CFTypeRef?
    guard AXUIElementCopyAttributeValue(win, kAXSizeAttribute as CFString, &val) == .success, let v = val else {
      return nil
    }
    var sz = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &sz) ? sz : nil
  }

  private func setAXWindowBounds(_ win: AXUIElement, origin: CGPoint, size: CGSize?) {
    var pt = origin
    if let posVal = AXValueCreate(.cgPoint, &pt) {
      _ = AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, posVal)
    }
    if var sz = size, let sizeVal = AXValueCreate(.cgSize, &sz) {
      _ = AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, sizeVal)
      // Re-apply position after resize in case macOS constrained the frame while crossing displays.
      if let posVal = AXValueCreate(.cgPoint, &pt) {
        _ = AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, posVal)
      }
    }
  }

  private func isExactWindow(_ window: AXUIElement, pid: Int32, id: Int) -> Bool {
    var owner: pid_t = 0
    var number: CGWindowID = 0
    return AXUIElementGetPid(window,&owner) == .success && owner == pid
      && _AXUIElementGetWindow(window,&number) == .success && Int(number) == id
  }

  private func isFocusedWindow(pid: Int32, id: Int) -> Bool {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return false }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.2)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &value) == .success,
          let window = value, CFGetTypeID(window) == AXUIElementGetTypeID() else { return false }
    return isExactWindow(window as! AXUIElement, pid: pid, id: id)
  }

  private func findAXWindow(pid: Int32, windowId: Int, hintBounds: CGRect?) -> AXUIElement? {
    let axApp = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(axApp, 0.5)
    func remember(_ window: AXUIElement) -> AXUIElement {
      if let app = NSRunningApplication(processIdentifier:pid),
         isExactWindow(window,pid:pid,id:windowId) {
        recentWindows.removeAll { $0.id == windowId || $0.app.isTerminated }
        if recentWindows.count >= 8 { recentWindows.removeFirst() }
        recentWindows.append((windowId,app,window))
      }
      return window
    }
    var val: CFTypeRef?
    _ = AXUIElementCopyAttributeValue(axApp,kAXWindowsAttribute as CFString,&val)
    let wins = val as? [AXUIElement] ?? []
    var matches: [AXUIElement] = []
    for w in wins {
      var wid: CGWindowID = 0
      if _AXUIElementGetWindow(w, &wid) == .success && wid != 0 {
        if Int(wid) == windowId { return remember(w) }
        continue
      }
      if let hint = hintBounds, let p = axWindowPosition(w), let size = axWindowSize(w),
         abs(p.x - hint.minX) <= 4, abs(p.y - hint.minY) <= 4,
         abs(size.width - hint.width) <= 4, abs(size.height - hint.height) <= 4 {
        matches.append(w)
      }
    }
    // Some AX providers return an empty window array while retaining the
    // main/focused window. Only use these alternate handles by exact CG ID.
    for attr in [kAXMainWindowAttribute,kAXFocusedWindowAttribute] {
      var value: CFTypeRef?
      guard AXUIElementCopyAttributeValue(axApp,attr as CFString,&value) == .success,
            let window = value, CFGetTypeID(window) == AXUIElementGetTypeID() else { continue }
      let element = window as! AXUIElement
      var wid: CGWindowID = 0
      if _AXUIElementGetWindow(element,&wid) == .success && Int(wid) == windowId { return remember(element) }
    }
    // An app on another Space may lose its AX window inventory while a
    // previously acquired window remains addressable. Never cache a handle
    // obtained by geometry alone or transfer it across application launches.
    if wins.isEmpty, let index = recentWindows.firstIndex(where:{ $0.id == windowId }) {
      let saved = recentWindows.remove(at:index)
      if !saved.app.isTerminated, saved.app.processIdentifier == pid,
         cgWindowInfo(windowId:windowId)?.pid == pid, isExactWindow(saved.handle,pid:pid,id:windowId) {
        recentWindows.append(saved)
        return saved.handle
      }
    }
    return matches.count == 1 ? matches[0] : nil
  }

  private func isRectFullyOnDisplay(_ rect: CGRect, display: CGRect) -> Bool {
    guard rect.width > 20 && rect.height > 20 && display.width > 20 && display.height > 20 else {
      return false
    }
    return rect.minX >= display.minX - 4
      && rect.minY >= display.minY - 4
      && rect.maxX <= display.maxX + 4
      && rect.maxY <= display.maxY + 4
  }

  private func resolveTargetWindowAtPoint(
    mainWindowId: Int,
    mainBounds: CGRect,
    point: CGPoint,
    targetPid: Int32,
    inPlace: Bool = false
  ) -> (windowId: Int, bounds: CGRect)? {
    if inPlace {
      // WindowServer also lists transparent Dock tracking windows above apps.
      // AppKit hit-testing identifies the window that actually accepts the point.
      let nsPoint = NSPoint(x: point.x, y: primaryScreenHeight() - point.y)
      let hit = NSWindow.windowNumber(at: nsPoint, belowWindowWithWindowNumber: 0)
      if hit == mainWindowId, mainBounds.contains(point) { return (hit, mainBounds) }
      guard let popup = popupFrames(above: CGWindowID(mainWindowId), owner: targetPid, mainFrame: mainBounds)
        .first(where: { Int($0.id) == hit && $0.frame.contains(point) }) else { return nil }
      return (hit, popup.frame)
    }
    guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
      return (mainWindowId, mainBounds)
    }
    // Rows are returned front-to-back. Find the topmost visible window containing `point`.
    for row in rows {
      guard let wid = row[kCGWindowNumber as String] as? Int, wid > 0 else { continue }
      let alpha = (row[kCGWindowAlpha as String] as? Double) ?? 1.0
      guard alpha > 0.01 else { continue }
      let layer = (row[kCGWindowLayer as String] as? Int) ?? 0
      // Skip system cursor / Dock / menu-bar chrome layers above normal app popups.
      if layer >= 1000 { continue }
      guard let b = row[kCGWindowBounds as String] as? [String: Any] else { continue }
      let rect = CGRect(
        x: (b["X"] as? CGFloat) ?? CGFloat((b["X"] as? Double) ?? 0),
        y: (b["Y"] as? CGFloat) ?? CGFloat((b["Y"] as? Double) ?? 0),
        width: (b["Width"] as? CGFloat) ?? CGFloat((b["Width"] as? Double) ?? 0),
        height: (b["Height"] as? CGFloat) ?? CGFloat((b["Height"] as? Double) ?? 0)
      )
      guard rect.width >= 12 && rect.height >= 12 && rect.contains(point) else { continue }
      let ownerPid = (row[kCGWindowOwnerPID as String] as? Int32) ?? 0
      if wid == mainWindowId {
        return (mainWindowId, rect)
      }
      if ownerPid != targetPid {
        // Another application is covering this point on the stage.
        return nil
      }
      if popupFrames(above: CGWindowID(mainWindowId), owner: targetPid, mainFrame: mainBounds).contains(where: { $0.id == CGWindowID(wid) }) {
        return (wid, rect)
      }
      return nil
    }
    return mainBounds.insetBy(dx: -6, dy: -6).contains(point) ? (mainWindowId, mainBounds) : nil
  }

  private func stageWindowOnMain(
    windowId: Int,
    pid: Int32?,
    bundleId: String?,
    appName: String?,
    appPath: String?,
    keepWindowInPlace: Bool = false
  ) -> [String: Any] {
    guard AXIsProcessTrusted() else {
      return [
        "ok": false,
        "code": "desktop_accessibility_permission",
        "error": "辅助功能权限未开启，无法将窗口移入后台虚拟舞台。",
      ]
    }
    let cgBefore = cgWindowInfo(windowId: windowId)
    let resolvedPid = pid ?? cgBefore?.pid
    guard let targetApp = resolveRunningApp(pid: resolvedPid, bundleId: bundleId, appName: appName, appPath: appPath) else {
      return [
        "ok": false,
        "code": "desktop_process_not_found",
        "error": "找不到目标运行中的应用进程。",
      ]
    }
    let appPid = targetApp.processIdentifier
    let expectedPath = appPath.flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0).standardizedFileURL.path }
    guard cgBefore?.pid == appPid,
          bundleId?.isEmpty != false || bundleId?.lowercased() == targetApp.bundleIdentifier?.lowercased(),
          expectedPath == nil || expectedPath == targetApp.bundleURL?.standardizedFileURL.path else {
      return ["ok": false, "code": "desktop_window_mismatch", "error": "窗口已关闭或已不属于指定应用。"]
    }

    if let bounds = cgBefore?.bounds {
      var displays = [CGDirectDisplayID](repeating: 0, count: 8)
      var count: UInt32 = 0
      let center = CGPoint(x: bounds.midX, y: bounds.midY)
      if CGGetDisplaysWithPoint(center, UInt32(displays.count), &displays, &count) == .success,
         displays.prefix(Int(count)).contains(where: {
           $0 != displayID && CGDisplayVendorNumber($0) == 0x5354 && CGDisplayModelNumber($0) == 0x5049
         }) {
        return ["ok": false, "code": "desktop_window_busy", "error": "该窗口正由另一后台舞台使用。"]
      }
    }

    // A visible dropdown can close as soon as its parent changes display. Keep
    // both windows in place and verify the observed popup again at dispatch.
    if keepWindowInPlace {
      guard cgBefore?.onscreen == true else {
        return ["ok": false, "code": "desktop_popup_changed", "error": "原窗口已离开屏幕，请重新读取搜索结果。"]
      }
      return ["ok": true, "staged": stagedWindows[windowId] != nil, "pid": Int(appPid)]
    }

    // If the user changes Spaces during display creation, reuse only the
    // exact handle acquired while the target window was still visible.
    var visibleWindow: AXUIElement?
    if cgBefore?.onscreen == true, stagedWindows[windowId] == nil,
       let handle = findAXWindow(pid:appPid,windowId:windowId,hintBounds:cgBefore?.bounds),
       isExactWindow(handle,pid:appPid,id:windowId) { visibleWindow = handle }
    // Drain temporary Objective-C display-creation references here. The
    // stage manager then owns the lifetime of its display across requests.
    guard let vd = autoreleasepool(invoking: { ensureDisplayOnMain() }) else {
      return [
        "ok": false,
        "code": "virtual_stage_unavailable",
        "error": "当前 macOS 环境不支持虚拟显示器舞台。",
      ]
    }

    // This also disconnects after a failed first borrow or a partially reverted move.
    defer { disconnectReleasedDisplayOnMain() }

    // Fast path: already onscreen and completely unclipped inside the virtual display!
    if let info = cgBefore, info.onscreen, info.alpha > 0.01, isRectFullyOnDisplay(info.bounds, display: vd.bounds) {
      guard var existing = stagedWindows[windowId], existing.pid == appPid else {
        return ["ok": false, "code": "desktop_window_busy", "error": "该窗口已位于后台显示器，其原始位置未知。"]
      }
      existing.stagedBounds = info.bounds
      existing.releasePending = false
      stagedWindows[windowId] = existing
      return [
        "ok": true,
        "staged": true,
        "alreadyStaged": true,
        "windowId": windowId,
        "pid": Int(appPid),
        "displayID": Int(vd.displayID),
        "displayBounds": rectToDict(vd.bounds),
        "windowBounds": rectToDict(info.bounds),
      ]
    }

    if let first = visibleWindow, !isExactWindow(first,pid:appPid,id:windowId) { visibleWindow = nil }
    guard let winEl = visibleWindow ?? findAXWindow(pid: appPid, windowId: windowId, hintBounds: cgBefore?.bounds) else {
      return [
        "ok": false,
        "code": "stage_window_not_accessible",
        "error": "未能读取目标窗口的辅助功能句柄，无法移入后台虚拟舞台。",
      ]
    }

    let observedBounds: CGRect? = {
      // A new borrow after the user moved the window starts at their latest position.
      if let existing = stagedWindows[windowId], existing.pid == appPid,
         cgBefore.map({ vd.bounds.intersects($0.bounds) }) != false {
        return existing.originalBounds
      }
      if let b = cgBefore?.bounds, b.width >= 80 && b.height >= 60 {
        return b
      }
      if let p = axWindowPosition(winEl), let s = axWindowSize(winEl), s.width >= 80 && s.height >= 60 {
        return CGRect(origin: p, size: s)
      }
      return nil
    }()
    guard let currentOrigBounds = observedBounds else {
      return ["ok": false, "code": "stage_window_not_accessible", "error": "无法读取目标窗口的位置与尺寸。"]
    }

    let maxW = max(320, vd.bounds.width - 32)
    let maxH = max(240, vd.bounds.height - 48)
    let targetW = min(currentOrigBounds.width, maxW)
    let targetH = min(currentOrigBounds.height, maxH)
    let needsResize = abs(targetW - currentOrigBounds.width) > 4 || abs(targetH - currentOrigBounds.height) > 4
    let targetOrigin = CGPoint(
      x: vd.bounds.origin.x + max(16, floor((vd.bounds.width - targetW) / 2)),
      y: vd.bounds.origin.y + max(24, floor((vd.bounds.height - targetH) / 2))
    )

    setAXWindowBounds(winEl, origin: targetOrigin, size: needsResize ? CGSize(width: targetW, height: targetH) : nil)
    pumpMainRunLoop(0.16)

    // Verify window landed completely inside the virtual display (never clipped off the right/bottom edge).
    var cgAfter = cgWindowInfo(windowId: windowId)
    if cgAfter == nil || !isRectFullyOnDisplay(cgAfter!.bounds, display: vd.bounds) {
      setAXWindowBounds(winEl, origin: targetOrigin, size: CGSize(width: targetW, height: targetH))
      pumpMainRunLoop(0.18)
      cgAfter = cgWindowInfo(windowId: windowId)
    }

    guard let landed = cgAfter, landed.onscreen, isRectFullyOnDisplay(landed.bounds, display: vd.bounds) else {
      setAXWindowBounds(winEl, origin: currentOrigBounds.origin, size: currentOrigBounds.size)
      pumpMainRunLoop(0.08)
      if let partial = cgWindowInfo(windowId: windowId), partial.pid == appPid,
         !sameWindowFrame(partial.bounds, currentOrigBounds) {
        // A failed move can also leave the window resized on a physical screen.
        stagedWindows[windowId] = StagedWindowRecord(
          windowId: windowId, pid: appPid, window: winEl, bundleId: targetApp.bundleIdentifier ?? "",
          appName: targetApp.localizedName ?? "", originalBounds: currentOrigBounds,
          stagedBounds: partial.bounds, stagedAt: Date().timeIntervalSince1970, releasePending: true
        )
      }
      return [
        "ok": false,
        "code": "stage_move_failed",
        "error": "目标窗口未能完整移动到后台虚拟舞台（当前可能被系统锁定或超出舞台边界）。",
      ]
    }

    stagedWindows[windowId] = StagedWindowRecord(
      windowId: windowId,
      pid: appPid,
      window: winEl,
      bundleId: targetApp.bundleIdentifier ?? (bundleId ?? ""),
      appName: targetApp.localizedName ?? (appName ?? ""),
      originalBounds: currentOrigBounds,
      stagedBounds: landed.bounds,
      stagedAt: Date().timeIntervalSince1970
    )

    return [
      "ok": true,
      "staged": true,
      "alreadyStaged": false,
      "windowId": windowId,
      "pid": Int(appPid),
      "displayID": Int(vd.displayID),
      "displayBounds": rectToDict(vd.bounds),
      "windowBounds": rectToDict(landed.bounds),
      "originalBounds": rectToDict(currentOrigBounds),
    ]
  }

  private func returnFrame(_ rec: StagedWindowRecord) -> CGRect {
    let physical = physicalDisplayBoundsExcludingStage()
    var frame = rec.originalBounds
    if !physical.contains(where: { $0.intersects(frame) }), let screen = physical.first {
      frame.origin = CGPoint(x: screen.minX + 120, y: screen.minY + 80)
    }
    return frame
  }

  private func restoreGeometry(_ rec: StagedWindowRecord, target: CGRect) -> CGRect? {
    func windowFrame() -> CGRect? {
      guard let item = cgWindowInfo(windowId: rec.windowId), item.pid == rec.pid else { return nil }
      return item.bounds
    }
    guard let win = returnWindow(rec) else { return windowFrame() }
    return restoreWindowFrame(target: target, read: windowFrame, apply: { frame in
      self.setAXWindowBounds(win, origin: frame.origin, size: frame.size)
    }, wait: { self.pumpMainRunLoop(0.045) })
  }

  private func returnWindow(_ rec: StagedWindowRecord) -> AXUIElement? {
    guard let info = cgWindowInfo(windowId:rec.windowId), info.pid == rec.pid else { return nil }
    // AXWindows can disappear when the original Space is inactive. Keep the
    // borrowed handle, but only reuse it when it still identifies this window.
    if isExactWindow(rec.window,pid:rec.pid,id:rec.windowId) { return rec.window }
    return findAXWindow(pid:rec.pid,windowId:rec.windowId,hintBounds:info.bounds)
  }

  // WindowServer may rehome or resize a window after the last virtual display
  // reference is released. Check the frame on the final display configuration.
  @discardableResult
  private func disconnectReleasedDisplayOnMain() -> [Int: CGRect] {
    guard displayID != 0, stagedWindows.values.allSatisfy({ $0.releasePending }) else { return [:] }
    let id = displayID
    let stage = CGDisplayBounds(id)
    let physical = physicalDisplayBoundsExcludingStage()
    let pending = stagedWindows.values.filter { rec in
      guard let current = cgWindowInfo(windowId: rec.windowId), current.pid == rec.pid else { return false }
      return stage.intersects(current.bounds) || sameWindowFrame(current.bounds,rec.stagedBounds)
        || (!physical.isEmpty && !hasUsableWindowArea(current.bounds,on:physical))
    }
    stagedWindows.removeAll()
    teardownDisplayOnlyOnMain()
    guard !pending.isEmpty else { return [:] }
    for _ in 0..<24 {
      if CGDisplayIsOnline(id) == 0 { break }
      pumpMainRunLoop(0.04)
    }
    var frames: [Int: CGRect] = [:]
    var releasedByUser = Set<Int>()
    // Display removal and Space re-layout are separate WindowServer events.
    // A few correct early reads can precede a later move almost entirely off
    // the screen. Sample all borrowed windows together through that transition.
    for delay in [0.0,0.09,0.15,0.24,0.30,0.36,0.38,0.12] {
      if delay > 0 { pumpMainRunLoop(delay) }
      let screens = physicalDisplayBoundsExcludingStage()
      for rec in pending where !releasedByUser.contains(rec.windowId) {
        guard let current = cgWindowInfo(windowId:rec.windowId), current.pid == rec.pid else {
          frames.removeValue(forKey:rec.windowId)
          releasedByUser.insert(rec.windowId)
          continue
        }
        frames[rec.windowId] = current.bounds
        let target = returnFrame(rec)
        guard !sameWindowFrame(current.bounds,target), !screens.isEmpty else { continue }
        if shouldRestoreAfterDisconnect(current.bounds,target:target,ownedFrame:rec.stagedBounds,displays:screens) {
          if let win = returnWindow(rec) { setAXWindowBounds(win,origin:target.origin,size:target.size) }
        } else {
          // A window the user placed normally on another display is theirs.
          releasedByUser.insert(rec.windowId)
        }
      }
    }
    for rec in pending where !releasedByUser.contains(rec.windowId) {
      if let current = cgWindowInfo(windowId:rec.windowId), current.pid == rec.pid {
        frames[rec.windowId] = current.bounds
      } else { frames.removeValue(forKey:rec.windowId) }
    }
    return frames
  }

  private func releaseWindowOnMain(windowId: Int, focus: Bool, teardownIfEmpty: Bool) -> [String: Any] {
    defer {
      if teardownIfEmpty { disconnectReleasedDisplayOnMain() }
    }

    guard let rec = stagedWindows[windowId] else {
      return ["ok": true, "released": false, "windowId": windowId]
    }
    func forget(_ reason: String) -> [String: Any] {
      stagedWindows.removeValue(forKey: windowId)
      return ["ok": true, "released": false, "restored": false, "reason": reason, "windowId": windowId]
    }

    guard let current = cgWindowInfo(windowId: windowId), current.pid == rec.pid else {
      return forget("window_closed")
    }
    let physical = physicalDisplayBoundsExcludingStage()
    guard displayID != 0, CGDisplayIsActive(displayID) != 0 else {
      return forget("window_left_stage")
    }
    let stage = CGDisplayBounds(displayID)
    let unfinishedMove = rec.releasePending && stage.intersects(current.bounds)
      && !physical.contains(where: { $0.intersects(current.bounds) })
    let knownPartialRestore = rec.releasePending && sameWindowFrame(current.bounds, rec.stagedBounds)
    guard isRectFullyOnDisplay(current.bounds, display: stage) || unfinishedMove || knownPartialRestore else {
      // The user moved the window or disconnected the stage. Respect its new position.
      return forget("window_left_stage")
    }

    let target = returnFrame(rec)
    guard var frame = restoreGeometry(rec, target: target) else { return forget("window_closed") }
    stagedWindows[windowId]?.stagedBounds = frame
    stagedWindows[windowId]?.releasePending = true
    var reason = "returned_to_display"
    if teardownIfEmpty && stagedWindows.values.allSatisfy({ $0.releasePending }) {
      let after = disconnectReleasedDisplayOnMain()
      guard let final = after[windowId] else { return forget("window_left_stage") }
      frame = final
      reason = "display_disconnected"
    }
    let returned = sameWindowFrame(frame,target) || hasUsableWindowArea(frame,on:physicalDisplayBoundsExcludingStage())
    if focus && returned, let win = findAXWindow(pid: rec.pid, windowId: windowId, hintBounds: frame),
       let app = NSRunningApplication(processIdentifier: rec.pid) {
      _ = AXUIElementPerformAction(win, kAXRaiseAction as CFString)
      if #available(macOS 14.0, *) { app.activate(options: []) }
      else { app.activate(options: [.activateIgnoringOtherApps]) }
    }
    if !returned {
      return ["ok": false, "released": false, "code": "stage_restore_failed", "windowId": windowId,
              "error": "未能确认目标窗口已返回原屏幕的可用区域。"]
    }
    let restored = sameWindowFrame(frame, rec.originalBounds)
    return ["ok": true, "released": returned, "restored": restored, "reason": restored ? reason : "window_geometry_changed",
            "windowId": windowId, "originalBounds": rectToDict(rec.originalBounds), "windowBounds": rectToDict(frame)]
  }

  private func teardownDisplayOnlyOnMain() {
    virtualDisplay = nil
    displayID = 0
    displayBounds = .zero
  }

  func teardownAll() {
    let work = {
      let ids = Array(self.stagedWindows.keys)
      for wid in ids {
        _ = self.releaseWindowOnMain(windowId: wid, focus: false, teardownIfEmpty: true)
      }
      self.stagedWindows.removeAll()
      self.teardownDisplayOnlyOnMain()
    }
    if Thread.isMainThread {
      work()
    } else {
      DispatchQueue.main.sync(execute: work)
    }
  }

  private func resolvePoint(action: StageActionInput, bounds: CGRect, useEnd: Bool = false) -> CGPoint? {
    let nx = useEnd ? action.toNormX : action.normX
    let ny = useEnd ? action.toNormY : action.normY
    if let nx = nx, let ny = ny {
      guard nx >= 0, nx <= 1000, ny >= 0, ny <= 1000, bounds.width > 0, bounds.height > 0 else { return nil }
      return CGPoint(
        x: (bounds.origin.x + (CGFloat(nx) / 1000.0) * bounds.width).rounded(),
        y: (bounds.origin.y + (CGFloat(ny) / 1000.0) * bounds.height).rounded()
      )
    }
    let rx = useEnd ? action.toRx : action.rx
    let ry = useEnd ? action.toRy : action.ry
    if let rx = rx, let ry = ry {
      guard bounds.width > 0, bounds.height > 0 else { return nil }
      let imgW = action.imageWidth ?? 0
      let imgH = action.imageHeight ?? 0
      let sx = imgW > 0 ? (CGFloat(rx) / CGFloat(imgW)) * bounds.width : CGFloat(rx)
      let sy = imgH > 0 ? (CGFloat(ry) / CGFloat(imgH)) * bounds.height : CGFloat(ry)
      return CGPoint(x: (bounds.origin.x + sx).rounded(), y: (bounds.origin.y + sy).rounded())
    }
    let x = useEnd ? action.toX : action.x
    let y = useEnd ? action.toY : action.y
    if let x = x, let y = y {
      return CGPoint(x: CGFloat(x).rounded(), y: CGFloat(y).rounded())
    }
    return nil
  }

  private func pointInBounds(_ pt: CGPoint, _ bounds: CGRect, pad: CGFloat = 6) -> Bool {
    pt.x >= bounds.minX - pad
      && pt.y >= bounds.minY - pad
      && pt.x <= bounds.maxX + pad
      && pt.y <= bounds.maxY + pad
  }

  private var syntheticEventNumber: Int = 1000

  private func primaryScreenHeight() -> CGFloat {
    NSScreen.screens.first?.frame.size.height ?? 1080
  }

  /// Sends a process-targeted mouse click directly to `targetPid` / `targetWindowId`
  /// without moving the hardware cursor or stealing active application focus.
  private func postMouseClickToPid(
    pid: Int32,
    targetWindowId: Int,
    targetBounds: CGRect,
    globalPoint: CGPoint,
    button: String,
    clicks: Int
  ) {
    let isRight = button.lowercased() == "right"
    let downType: NSEvent.EventType = isRight ? .rightMouseDown : .leftMouseDown
    let upType: NSEvent.EventType = isRight ? .rightMouseUp : .leftMouseUp
    let primaryH = primaryScreenHeight()
    let localCgX = globalPoint.x - targetBounds.origin.x
    let localCgY = globalPoint.y - targetBounds.origin.y
    let nsPoint = NSPoint(x: localCgX, y: primaryH - localCgY)

    for i in 1...max(1, min(clicks, 3)) {
      syntheticEventNumber += 1
      let evNum = syntheticEventNumber
      if let downNs = NSEvent.mouseEvent(
        with: downType,
        location: nsPoint,
        modifierFlags: [],
        timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: targetWindowId,
        context: nil,
        eventNumber: evNum,
        clickCount: i,
        pressure: 1.0
      ), let downCg = downNs.cgEvent {
        downCg.postToPid(pid)
      }
      usleep(22_000)
      if let upNs = NSEvent.mouseEvent(
        with: upType,
        location: nsPoint,
        modifierFlags: [],
        timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: targetWindowId,
        context: nil,
        eventNumber: evNum,
        clickCount: i,
        pressure: 0.0
      ), let upCg = upNs.cgEvent {
        upCg.postToPid(pid)
      }
      if i < clicks { usleep(36_000) }
    }
  }

  /// Sends a keystroke directly to `pid` using a `.privateState` source so the user's
  /// physical modifier keys never bleed in and active app focus is never stolen.
  private func scrollWindow(pid: Int32, window: Int, bounds: CGRect, point: CGPoint,
                            dx: Int32, dy: Int32, unit: CGScrollEventUnit) -> Bool {
    // A Quartz wheel made directly has NSEvent.windowNumber == 0. Qt drops
    // that event while its app is inactive. Keep the target AppKit window
    // from the same documented NSEvent constructor used by window clicks.
    let location = NSPoint(x:point.x-bounds.minX,y:primaryScreenHeight()-(point.y-bounds.minY))
    syntheticEventNumber += 1
    guard let wheel = CGEvent(scrollWheelEvent2Source:nil,units:unit,wheelCount:2,wheel1:dy,wheel2:dx,wheel3:0),
          let event = NSEvent.mouseEvent(with:.mouseMoved,location:location,modifierFlags:[],
            timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:window,context:nil,
            eventNumber:syntheticEventNumber,clickCount:0,pressure:0)?.cgEvent else { return false }
    event.type = .scrollWheel
    for field: CGEventField in [.scrollWheelEventIsContinuous,.scrollWheelEventDeltaAxis1,.scrollWheelEventDeltaAxis2,
                                .scrollWheelEventPointDeltaAxis1,.scrollWheelEventPointDeltaAxis2] {
      event.setIntegerValueField(field,value:wheel.getIntegerValueField(field))
    }
    for field: CGEventField in [.scrollWheelEventFixedPtDeltaAxis1,.scrollWheelEventFixedPtDeltaAxis2] {
      event.setDoubleValueField(field,value:wheel.getDoubleValueField(field))
    }
    guard NSEvent(cgEvent:event)?.windowNumber == window else { return false }
    event.postToPid(pid)
    return true
  }

  private func postKeyToPid(pid: Int32, code: UInt16, flags: CGEventFlags = []) {
    let src = CGEventSource(stateID: .privateState)
    if let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
       let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) {
      down.flags = flags
      up.flags = flags
      down.postToPid(pid)
      usleep(18_000)
      up.postToPid(pid)
    }
  }

  private func isFocusedElementSecure(pid: Int32) -> Bool {
    let axApp = AXUIElementCreateApplication(pid)
    var focusedVal: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXFocusedUIElementAttribute as CFString, &focusedVal) == .success,
          let el = focusedVal else {
      return false
    }
    let axEl = el as! AXUIElement
    func strAttr(_ name: String) -> String {
      var v: CFTypeRef?
      guard AXUIElementCopyAttributeValue(axEl, name as CFString, &v) == .success, let s = v as? String else {
        return ""
      }
      return s
    }
    let combined = "\(strAttr(kAXRoleAttribute)) \(strAttr(kAXSubroleAttribute)) \(strAttr(kAXDescriptionAttribute))".lowercased()
    return combined.contains("secure") || combined.contains("password")
  }

  /// Types literal Unicode/Chinese text directly into `pid` via `CGEventKeyboardSetUnicodeString`
  /// and `postToPid` — never touches the user's clipboard and never steals keyboard focus.
  private func typeUnicodeToPid(pid: Int32, text: String, clear: Bool, submit: Bool,
                                permitted: () -> Bool = { true }) -> (ok: Bool, code: String?, error: String?) {
    let focusLost = (false, "desktop_foreground_required", "目标窗口已失去焦点。请先核对搜索框中的文字。")
    if isFocusedElementSecure(pid: pid) {
      return (false, "desktop_secure_target", "不会向密码或安全输入框输入内容。")
    }

    if clear {
      guard permitted() else { return focusLost }
      postKeyToPid(pid: pid, code: 0, flags: .maskCommand) // Cmd+A
      usleep(35_000)
      guard permitted() else { return focusLost }
      postKeyToPid(pid: pid, code: 51, flags: []) // Backspace
      usleep(35_000)
    }

    let src = CGEventSource(stateID: .privateState)
    let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    let utf16 = Array(normalized.utf16)
    var offset = 0
    // CGEventKeyboardSetUnicodeString caps each event at 20 UTF-16 code units; chunk by 16 safely.
    while offset < utf16.count {
      guard permitted() else { return focusLost }
      var end = min(offset + 16, utf16.count)
      // Avoid splitting a UTF-16 surrogate pair across events.
      if end < utf16.count && utf16[end - 1] >= 0xD800 && utf16[end - 1] <= 0xDBFF {
        end -= 1
      }
      if end <= offset { end = min(offset + 2, utf16.count) }
      var chunk = Array(utf16[offset..<end])
      if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
         let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
        down.flags = []
        up.flags = []
        down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        down.postToPid(pid)
        usleep(12_000)
        up.postToPid(pid)
      }
      offset = end
      if offset < utf16.count { usleep(10_000) }
    }

    pumpMainRunLoop(0.08)
    if submit {
      guard permitted() else { return focusLost }
      postKeyToPid(pid: pid, code: 36, flags: [])
      pumpMainRunLoop(0.08)
    }
    return (true, nil, nil)
  }

  private func parseHotkey(action: StageActionInput) -> (keyCode: UInt16, flags: CGEventFlags, chord: String, blocked: Bool)? {
    var mods: Set<String> = []
    for raw in action.modifiers ?? [] {
      let m = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      if m == "cmd" || m == "command" || m == "meta" || m == "win" { mods.insert("command") }
      else if m == "shift" { mods.insert("shift") }
      else if m == "option" || m == "alt" || m == "opt" { mods.insert("option") }
      else if m == "control" || m == "ctrl" { mods.insert("control") }
    }
    var keyToken = (action.key ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if keyToken.contains("+") {
      let parts = keyToken.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
      if let last = parts.last {
        keyToken = last
        for m in parts.dropLast() {
          if m == "cmd" || m == "command" || m == "meta" || m == "win" { mods.insert("command") }
          else if m == "shift" { mods.insert("shift") }
          else if m == "option" || m == "alt" || m == "opt" { mods.insert("option") }
          else if m == "control" || m == "ctrl" { mods.insert("control") }
        }
      }
    }
    let resolvedCode: UInt16? = {
      if let explicit = action.keyCode, explicit >= 0, explicit <= 127 { return UInt16(explicit) }
      return NAMED_KEY_CODES[keyToken]
    }()
    guard let code = resolvedCode else { return nil }

    let blocked = (mods.contains("command") && (keyToken == "q" || keyToken == "tab" || keyToken == "space" || keyToken == "h" || keyToken == "m"))
      || (mods.contains("command") && mods.contains("option") && (keyToken == "escape" || keyToken == "esc"))
      || (mods.contains("command") && mods.contains("control") && keyToken == "q")

    var flags: CGEventFlags = []
    if mods.contains("command") { flags.insert(.maskCommand) }
    if mods.contains("shift") { flags.insert(.maskShift) }
    if mods.contains("option") { flags.insert(.maskAlternate) }
    if mods.contains("control") { flags.insert(.maskControl) }

    let orderedMods = ["control", "option", "shift", "command"].filter { mods.contains($0) }
    let chord = (orderedMods + [keyToken]).joined(separator: "+")
    return (code, flags, chord, blocked)
  }

  private func stageActOnMain(request: HelperRequest) -> [String: Any] {
    let windowId = request.windowId ?? 0
    guard windowId > 0 else {
      return ["ok": false, "code": "desktop_window_required", "error": "需要明确的 windowId。"]
    }
    guard CGPreflightPostEventAccess() else {
      return [
        "ok": false,
        "code": "desktop_accessibility_permission",
        "error": "macOS 未允许发送鼠标或键盘事件。请在系统设置的辅助功能中授权 Pi Studio Computer Use。",
      ]
    }

    let actions = request.actions ?? []
    let hasPopupClick = actions.contains { $0.popupWindowId != nil }
    if hasPopupClick && (actions.count != 1 || !["click", "double_click", "right_click"].contains((actions[0].type ?? actions[0].action ?? "").lowercased())) {
      return ["ok": false, "code": "desktop_act_invalid", "error": "请单独点击观察到的搜索面板，再核对结果。"]
    }
    // Moving a key window can dismiss its suggestions. Keep an active search in
    // place, including edits of an already-focused field and keyboard-opened search.
    let edits = actions.filter { ($0.type ?? $0.action) != "wait" }
    let input = edits.last
    let first = edits.first
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let foregroundTarget = frontPid != nil && cgWindowInfo(windowId: windowId)?.pid == frontPid
    let searchInPlace = foregroundTarget && request.searchField == true && input?.type == "type" && input?.submit != true
      && edits.dropLast().allSatisfy { $0.type == "click" || $0.type == "hotkey" }
    let clickInPlace = foregroundTarget && edits.count == 1 && first?.type == "click"
    let stageRes = stageWindowOnMain(
      windowId: windowId,
      pid: request.pid != nil ? Int32(request.pid!) : nil,
      bundleId: request.bundleId,
      appName: request.appName,
      appPath: request.appPath,
      keepWindowInPlace: hasPopupClick || searchInPlace || clickInPlace
    )
    guard (stageRes["ok"] as? Bool) == true, let pidInt = stageRes["pid"] as? Int else {
      return stageRes
    }
    let targetPid = Int32(pidInt)
    guard NSRunningApplication(processIdentifier: targetPid) != nil else {
      return ["ok": false, "code": "desktop_process_not_found", "error": "目标应用进程已退出。"]
    }

    let captureAfter = request.captureAfter ?? true
    let includePopups = request.includePopups ?? true
    let maxEdge = request.maxEdge ?? 1440
    let settleMs = max(0, min(request.settleMs ?? 260, 3000))

    // Deliver input to the owning process on its current display.
    var steps: [[String: Any]] = []
    var failedStep: [String: Any]? = nil
    var latestBounds = cgWindowInfo(windowId: windowId)?.bounds ?? .zero

    for (idx, item) in actions.enumerated() {
      let stepIndex = idx + 1
      let kind = (item.type ?? item.action ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      if let fresh = cgWindowInfo(windowId: windowId) {
        latestBounds = fresh.bounds
      }

      if searchInPlace && kind != "wait" {
        let point = resolvePoint(action: item, bounds: latestBounds)
        let hasTarget: Bool
        if let point {
          hasTarget = resolveTargetWindowAtPoint(mainWindowId: windowId, mainBounds: latestBounds, point: point, targetPid: targetPid, inPlace: true)?.windowId == windowId
        } else {
          hasTarget = isFocusedWindow(pid: targetPid, id: windowId)
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid, hasTarget else {
          failedStep = ["index": stepIndex, "type": kind, "code": "desktop_target_occluded", "error": "搜索框已离开前台或被遮挡，请重新读取窗口。"]
          steps.append(failedStep!.merging(["ok": false]) { _, new in new })
          break
        }
      }

      if kind == "wait" {
        let ms = max(30, min(item.ms ?? 300, 5000))
        pumpMainRunLoop(Double(ms) / 1000.0)
        steps.append(["index": stepIndex, "type": "wait", "ok": true, "ms": ms])
        continue
      }

      if kind == "click" || kind == "double_click" || kind == "right_click" {
        var coordinateBounds = latestBounds
        if let popup = item.popupWindowId {
          guard let id = CGWindowID(exactly: popup),
                let frame = popupFrames(above: CGWindowID(windowId), owner: targetPid, mainFrame: latestBounds).first(where: { $0.id == id })?.frame,
                item.popupBounds?.matches(frame) != false else {
            failedStep = ["index": stepIndex, "type": kind, "code": "desktop_popup_changed", "error": "搜索面板已关闭或移动。请重新读取该窗口。"]
            steps.append(failedStep!.merging(["ok": false]) { _, new in new })
            break
          }
          coordinateBounds = frame
        }
        guard let pt = resolvePoint(action: item, bounds: coordinateBounds), coordinateBounds.contains(pt) else {
          failedStep = ["index": stepIndex, "type": kind, "code": "desktop_invalid_point", "error": "点击坐标超出了所选画面。"]
          steps.append(failedStep!.merging(["ok": false]) { _, new in new })
          break
        }
        guard let hit = resolveTargetWindowAtPoint(mainWindowId: windowId, mainBounds: latestBounds, point: pt, targetPid: targetPid, inPlace: (searchInPlace || hasPopupClick || clickInPlace) && stageRes["staged"] as? Bool != true),
              item.popupWindowId == nil || hit.windowId == item.popupWindowId else {
          failedStep = ["index": stepIndex, "type": kind, "code": "desktop_target_occluded", "error": "所选位置已被遮挡。请重新读取该窗口。"]
          steps.append(failedStep!.merging(["ok": false]) { _, new in new })
          break
        }
        let button = kind == "right_click" ? "right" : (item.button ?? "left")
        let clicks = (kind == "double_click" || item.double == true) ? 2 : max(1, min(item.clickCount ?? 1, 3))
        postMouseClickToPid(
          pid: targetPid,
          targetWindowId: hit.windowId,
          targetBounds: hit.bounds,
          globalPoint: pt,
          button: button,
          clicks: clicks
        )
        steps.append([
          "index": stepIndex,
          "type": kind,
          "ok": true,
          "x": Int(pt.x.rounded()),
          "y": Int(pt.y.rounded()),
          "method": "virtual_stage_pid",
        ])
      } else if kind == "type" {
        let text = item.text ?? ""
        if text.isEmpty {
          failedStep = ["index": stepIndex, "type": "type", "code": "desktop_type_empty", "error": "请提供要输入的文本。"]
          steps.append(["index": stepIndex, "type": "type", "ok": false, "code": "desktop_type_empty", "error": "请提供要输入的文本。"])
          break
        }
        if let pt = resolvePoint(action: item, bounds: latestBounds) {
          guard pointInBounds(pt, latestBounds, pad: 6),
                let hit = resolveTargetWindowAtPoint(mainWindowId: windowId, mainBounds: latestBounds, point: pt, targetPid: targetPid, inPlace: searchInPlace) else {
            failedStep = ["index": stepIndex, "type": "type", "code": "desktop_foreground_required", "error": "输入目标位置无效或被遮挡。"]
            steps.append(["index": stepIndex, "type": "type", "ok": false, "code": "desktop_foreground_required", "error": "输入目标位置无效或被遮挡。"])
            break
          }
          postMouseClickToPid(
            pid: targetPid,
            targetWindowId: hit.windowId,
            targetBounds: hit.bounds,
            globalPoint: pt,
            button: "left",
            clicks: 1
          )
          pumpMainRunLoop(0.06)
        }
        let res = typeUnicodeToPid(pid: targetPid, text: text, clear: item.clear == true, submit: item.submit == true) {
          !searchInPlace || self.isFocusedWindow(pid: targetPid, id: windowId)
        }
        if !res.ok {
          let code = res.code ?? "desktop_type_failed"
          let err = res.error ?? "输入失败。"
          failedStep = ["index": stepIndex, "type": "type", "code": code, "error": err]
          steps.append(["index": stepIndex, "type": "type", "ok": false, "code": code, "error": err])
          break
        }
        steps.append([
          "index": stepIndex,
          "type": "type",
          "ok": true,
          "chars": text.count,
          "submitted": item.submit == true,
          "method": "virtual_stage_unicode",
          "valueVerified": false,
        ])
      } else if kind == "hotkey" {
        guard let parsed = parseHotkey(action: item) else {
          failedStep = ["index": stepIndex, "type": "hotkey", "code": "desktop_hotkey_invalid", "error": "不支持的快捷键。"]
          steps.append(["index": stepIndex, "type": "hotkey", "ok": false, "code": "desktop_hotkey_invalid", "error": "不支持的快捷键。"])
          break
        }
        if parsed.blocked {
          failedStep = ["index": stepIndex, "type": "hotkey", "code": "desktop_hotkey_blocked", "error": "已阻止高风险系统快捷键：\(parsed.chord)"]
          steps.append(["index": stepIndex, "type": "hotkey", "ok": false, "code": "desktop_hotkey_blocked", "error": "已阻止高风险系统快捷键：\(parsed.chord)"])
          break
        }
        postKeyToPid(pid: targetPid, code: parsed.keyCode, flags: parsed.flags)
        steps.append(["index": stepIndex, "type": "hotkey", "ok": true, "chord": parsed.chord, "method": "virtual_stage_pid"])
      } else if kind == "scroll" {
        let pt = resolvePoint(action: item, bounds: latestBounds) ?? CGPoint(x: latestBounds.midX, y: latestBounds.midY)
        guard pointInBounds(pt, latestBounds, pad: 6),
              let hit = resolveTargetWindowAtPoint(mainWindowId: windowId, mainBounds: latestBounds, point: pt, targetPid: targetPid) else {
          failedStep = ["index": stepIndex, "type": "scroll", "code": "desktop_foreground_required", "error": "滚动位置无效或被遮挡。"]
          steps.append(["index": stepIndex, "type": "scroll", "ok": false, "code": "desktop_foreground_required", "error": "滚动位置无效或被遮挡。"])
          break
        }
        var dx = item.dx ?? 0
        var dy = item.dy ?? 0
        let dir = (item.direction ?? "down").lowercased()
        let amt = max(1, min(item.amount ?? 3, 40))
        if dx == 0 && dy == 0 {
          switch dir {
          case "up": dy = amt
          case "down": dy = -amt
          case "left": dx = amt
          case "right": dx = -amt
          default: dy = -amt
          }
        }
        guard scrollWindow(pid:targetPid,window:hit.windowId,bounds:hit.bounds,point:pt,dx:Int32(dx),dy:Int32(dy),unit:.line) else {
          failedStep = ["index":stepIndex,"type":"scroll","code":"desktop_window_mismatch","error":"无法绑定滚动窗口。"]
          steps.append(failedStep!.merging(["ok":false]) { _,new in new })
          break
        }
        steps.append([
          "index": stepIndex,
          "type": "scroll",
          "ok": true,
          "x": Int(pt.x.rounded()),
          "y": Int(pt.y.rounded()),
          "direction": dir,
          "amount": max(abs(dx), abs(dy)),
          "method": "virtual_stage_pid",
        ])
      } else if kind == "drag" {
        guard let startPt = resolvePoint(action: item, bounds: latestBounds, useEnd: false),
              let endPt = resolvePoint(action: item, bounds: latestBounds, useEnd: true),
              pointInBounds(startPt, latestBounds, pad: 6),
              pointInBounds(endPt, latestBounds, pad: 6),
              let hit = resolveTargetWindowAtPoint(mainWindowId: windowId, mainBounds: latestBounds, point: startPt, targetPid: targetPid) else {
          failedStep = ["index": stepIndex, "type": "drag", "code": "desktop_invalid_point", "error": "拖拽坐标无效或超出目标窗口。"]
          steps.append(["index": stepIndex, "type": "drag", "ok": false, "code": "desktop_invalid_point", "error": "拖拽坐标无效或超出目标窗口。"])
          break
        }
        let dragSteps = max(2, min(item.steps ?? 12, 40))
        let primaryH = primaryScreenHeight()
        syntheticEventNumber += 1
        let evNum = syntheticEventNumber
        func dragNsPoint(_ p: CGPoint) -> NSPoint {
          NSPoint(x: p.x - hit.bounds.origin.x, y: primaryH - (p.y - hit.bounds.origin.y))
        }
        if let down = NSEvent.mouseEvent(
          with: .leftMouseDown, location: dragNsPoint(startPt), modifierFlags: [],
          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: hit.windowId,
          context: nil, eventNumber: evNum, clickCount: 1, pressure: 1.0
        )?.cgEvent {
          down.postToPid(targetPid)
        }
        for s in 1...dragSteps {
          let t = CGFloat(s) / CGFloat(dragSteps)
          let p = CGPoint(x: startPt.x + (endPt.x - startPt.x) * t, y: startPt.y + (endPt.y - startPt.y) * t)
          if let move = NSEvent.mouseEvent(
            with: .leftMouseDragged, location: dragNsPoint(p), modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: hit.windowId,
            context: nil, eventNumber: evNum, clickCount: 1, pressure: 1.0
          )?.cgEvent {
            move.postToPid(targetPid)
          }
          usleep(12_000)
        }
        if let up = NSEvent.mouseEvent(
          with: .leftMouseUp, location: dragNsPoint(endPt), modifierFlags: [],
          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: hit.windowId,
          context: nil, eventNumber: evNum, clickCount: 1, pressure: 0.0
        )?.cgEvent {
          up.postToPid(targetPid)
        }
        steps.append([
          "index": stepIndex,
          "type": "drag",
          "ok": true,
          "fromX": Int(startPt.x.rounded()),
          "fromY": Int(startPt.y.rounded()),
          "toX": Int(endPt.x.rounded()),
          "toY": Int(endPt.y.rounded()),
          "method": "virtual_stage_pid",
        ])
      } else {
        failedStep = ["index": stepIndex, "type": kind, "code": "desktop_act_invalid", "error": "不支持的动作类型：\(kind)"]
        steps.append(["index": stepIndex, "type": kind, "ok": false, "code": "desktop_act_invalid", "error": "不支持的动作类型：\(kind)"])
        break
      }

      if idx < actions.count - 1 {
        pumpMainRunLoop(0.09)
      }
    }

    if !actions.isEmpty && failedStep == nil && settleMs > 0 {
      pumpMainRunLoop(Double(settleMs) / 1000.0)
    }

    var screenshotPayload: [String: Any]? = nil
    var screenshotError: [String: Any]? = nil
    if captureAfter {
      let shot = captureWindowPayload(
        windowId: windowId,
        includePopups: includePopups,
        maxEdge: maxEdge,
        format: "png",
        quality: 0.78,
        timeoutMs: 10_000,
        popupWaitMs: failedStep == nil ? (request.popupWaitMs ?? 0) : 0
      )
      if (shot["ok"] as? Bool) == true {
        screenshotPayload = shot
      } else {
        screenshotError = [
          "code": (shot["code"] as? String) ?? "desktop_screenshot_failed",
          "message": (shot["error"] as? String) ?? "后台舞台截图失败。",
        ]
      }
    }

    if let fresh = cgWindowInfo(windowId: windowId) {
      latestBounds = fresh.bounds
    }

    var response: [String: Any] = [
      "ok": failedStep == nil,
      "staged": stageRes["staged"] as? Bool ?? false,
      "windowId": windowId,
      "displayID": Int(displayID),
      "displayBounds": rectToDict(displayBounds),
      "bounds": rectToDict(latestBounds),
      "steps": steps,
    ]
    if let fail = failedStep {
      response["failedStep"] = fail
    }
    if let shot = screenshotPayload {
      response["screenshot"] = shot
    }
    if let shotErr = screenshotError {
      response["screenshotError"] = shotErr
    }
    return response
  }

  func rememberCapturedWindow(_ id: Int) {
    guard id > 0, AXIsProcessTrusted(),
          let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow,CGWindowID(id)) as? [[String:Any]],
          let row = rows.first, row[kCGWindowNumber as String] as? Int == id,
          row[kCGWindowIsOnscreen as String] as? Bool == true,
          let pid = row[kCGWindowOwnerPID as String] as? Int32,
          let app = NSRunningApplication(processIdentifier:pid) else { return }
    DispatchQueue.main.async {
      guard !app.isTerminated else { return }
      if let saved = self.recentWindows.first(where:{ $0.id == id }),
         !saved.app.isTerminated, self.isExactWindow(saved.handle,pid:pid,id:id) { return }
      // Prepare only the captured window's handle while its Space is
      // still current. This does not change window placement or focus.
      _ = self.findAXWindow(pid:pid,windowId:id,hintBounds:nil)
    }
  }

  func stageWindow(request: HelperRequest) -> [String: Any] {
    stageQueue.sync {
      DispatchQueue.main.sync {
        self.stageWindowOnMain(
          windowId: request.windowId ?? 0,
          pid: request.pid != nil ? Int32(request.pid!) : nil,
          bundleId: request.bundleId,
          appName: request.appName,
          appPath: request.appPath
        )
      }
    }
  }

  func releaseWindow(request: HelperRequest) -> [String: Any] {
    stageQueue.sync {
      DispatchQueue.main.sync {
        self.releaseWindowOnMain(
          windowId: request.windowId ?? 0,
          focus: request.focus ?? false,
          teardownIfEmpty: request.teardownIfEmpty ?? true
        )
      }
    }
  }

  func stageAct(request: HelperRequest) -> [String: Any] {
    stageQueue.sync {
      DispatchQueue.main.sync {
        self.stageActOnMain(request: request)
      }
    }
  }

  func status() -> [String: Any] {
    stageQueue.sync {
      DispatchQueue.main.sync {
        let active = self.virtualDisplay != nil && self.displayID != 0 && CGDisplayIsActive(self.displayID) != 0
        let windows = self.stagedWindows.values.map { rec -> [String: Any] in
          [
            "windowId": rec.windowId,
            "pid": Int(rec.pid),
            "bundleId": rec.bundleId,
            "appName": rec.appName,
            "originalBounds": self.rectToDict(rec.originalBounds),
            "stagedBounds": self.rectToDict(rec.stagedBounds),
          ]
        }
        return [
          "ok": true,
          "supported": Self.isSupported,
          "active": active,
          "displayID": Int(self.displayID),
          "displayBounds": active ? self.rectToDict(CGDisplayBounds(self.displayID)) : NSNull(),
          "stagedWindows": windows,
        ]
      }
    }
  }
}

// MARK: - Unix Socket Server

private func writeJsonResponse(fd: Int32, payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
        let bytes = String(data: data, encoding: .utf8)?.appending("\n").data(using: .utf8) else {
    return
  }
  bytes.withUnsafeBytes { rawBuffer in
    guard let base = rawBuffer.baseAddress else { return }
    var sent = 0
    while sent < rawBuffer.count {
      let n = Darwin.write(fd, base.advanced(by: sent), rawBuffer.count - sent)
      if n <= 0 { break }
      sent += n
    }
  }
}

private func readRequestLine(fd: Int32) -> Data? {
  var buffer = Data()
  var chunk = [UInt8](repeating: 0, count: 8192)
  while buffer.count < MAX_REQUEST_BYTES {
    let n = Darwin.read(fd, &chunk, chunk.count)
    if n < 0 {
      if errno == EINTR { continue }
      return nil
    }
    if n == 0 { break }
    buffer.append(chunk, count: n)
    if let newline = buffer.firstIndex(of: 0x0A) {
      return buffer.subdata(in: 0..<newline)
    }
  }
  return buffer.isEmpty ? nil : buffer
}

private func handleClient(fd: Int32, expectedToken: String) {
  defer { close(fd) }
  var timeout = timeval(tv_sec: 20, tv_usec: 0)
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

  guard let line = readRequestLine(fd: fd) else {
    writeJsonResponse(fd: fd, payload: ["ok": false, "code": "invalid_request", "error": "Empty request"])
    return
  }

  guard let request = try? JSONDecoder().decode(HelperRequest.self, from: line) else {
    writeJsonResponse(fd: fd, payload: ["ok": false, "code": "invalid_json", "error": "Malformed JSON request"])
    return
  }

  guard let providedToken = request.token, constantTimeEquals(providedToken, expectedToken) else {
    writeJsonResponse(fd: fd, payload: ["ok": false, "code": "unauthorized", "error": "Invalid helper token"])
    return
  }

  let op = (request.op ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  switch op {
  case "ping":
    var payload = bundleMetadata()
    payload["ok"] = true
    payload["virtualStageSupported"] = VirtualStageManager.isSupported
    writeJsonResponse(fd: fd, payload: payload)

  case "permissions":
    writeJsonResponse(fd: fd, payload: currentPermissionPayload())

  case "request_permission":
    let payload = requestPermissionPayload(kind: request.kind ?? "screen")
    writeJsonResponse(fd: fd, payload: payload)

  case "exec":
    let command = request.command ?? ""
    let args = request.args ?? []
    let timeoutMs = request.timeoutMs ?? 15_000
    let payload = runAllowedCommand(command: command, args: args, timeoutMs: timeoutMs)
    writeJsonResponse(fd: fd, payload: payload)

  case "capture_window":
    let windowId = request.windowId ?? 0
    let includePopups = request.includePopups ?? true
    let maxEdge = request.maxEdge ?? 1440
    let format = request.format ?? "png"
    let quality = request.quality ?? 0.78
    let timeoutMs = request.timeoutMs ?? 10_000
    let payload = captureWindowPayload(
      windowId: windowId,
      includePopups: includePopups,
      maxEdge: maxEdge,
      format: format,
      quality: quality,
      timeoutMs: timeoutMs,
      popupWaitMs: request.popupWaitMs ?? 0
    )
    if payload["ok"] as? Bool == true { VirtualStageManager.shared.rememberCapturedWindow(windowId) }
    writeJsonResponse(fd: fd, payload: payload)

  case "stage_status":
    writeJsonResponse(fd: fd, payload: VirtualStageManager.shared.status())

  case "stage_window":
    writeJsonResponse(fd: fd, payload: VirtualStageManager.shared.stageWindow(request: request))

  case "stage_release":
    writeJsonResponse(fd: fd, payload: VirtualStageManager.shared.releaseWindow(request: request))

  case "stage_act":
    writeJsonResponse(fd: fd, payload: VirtualStageManager.shared.stageAct(request: request))

  case "stage_teardown":
    VirtualStageManager.shared.teardownAll()
    writeJsonResponse(fd: fd, payload: ["ok": true])

  case "shutdown":
    VirtualStageManager.shared.teardownAll()
    writeJsonResponse(fd: fd, payload: ["ok": true])
    DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(40)) {
      cleanupSocket()
      exit(0)
    }

  default:
    writeJsonResponse(fd: fd, payload: ["ok": false, "code": "unknown_op", "error": "Unknown op: \(op)"])
  }
}

private func loadConfig() -> HelperConfig? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--config"), index + 1 < args.count else {
    return nil
  }
  let configPath = args[index + 1]
  let url = URL(fileURLWithPath: configPath)
  defer {
    try? FileManager.default.removeItem(at: url)
  }
  guard let data = try? Data(contentsOf: url),
        let config = try? JSONDecoder().decode(HelperConfig.self, from: data) else {
    return nil
  }
  return config
}

private func createUnixServerSocket(path: String) -> Int32? {
  unlink(path)
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { return nil }

  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let pathBytes = Array(path.utf8)
  let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
  guard pathBytes.count < maxLen else {
    close(fd)
    return nil
  }
  withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
    ptr.withMemoryRebound(to: UInt8.self, capacity: maxLen) { dest in
      for i in 0..<pathBytes.count {
        dest[i] = pathBytes[i]
      }
      dest[pathBytes.count] = 0
    }
  }

  let bindStatus = withUnsafePointer(to: &addr) { ptr in
    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
      Darwin.bind(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  guard bindStatus == 0 else {
    close(fd)
    return nil
  }

  chmod(path, mode_t(0o600))

  guard listen(fd, 32) == 0 else {
    close(fd)
    unlink(path)
    return nil
  }
  return fd
}

private func startParentWatchdog(parentPid: Int32) {
  guard parentPid > 1 else { return }
  let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
  timer.schedule(deadline: .now() + 2, repeating: 2)
  timer.setEventHandler {
    if kill(parentPid, 0) != 0 && errno == ESRCH {
      VirtualStageManager.shared.teardownAll()
      cleanupSocket()
      exit(0)
    }
  }
  timer.resume()
  _ = Unmanaged.passRetained(timer)
}

signal(SIGPIPE, SIG_IGN)
signal(SIGTERM) { _ in
  cleanupSocket()
  exit(0)
}
signal(SIGINT) { _ in
  cleanupSocket()
  exit(0)
}

guard let config = loadConfig() else {
  // Launched without --config (e.g. double-clicked in Finder): exit quietly.
  exit(0)
}

guard let serverFd = createUnixServerSocket(path: config.socketPath) else {
  exit(1)
}

globalSocketPath = config.socketPath
globalServerFd = serverFd
startParentWatchdog(parentPid: config.parentPid)

// Initialize AppKit headless connection on the main thread so CGVirtualDisplay, NSWorkspace,
// NSPasteboard, and NSWindow hit-testing work natively inside the helper.
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let acceptQueue = DispatchQueue(label: "dev.pi.studio.computer-use.accept")
let clientQueue = DispatchQueue(label: "dev.pi.studio.computer-use.clients", attributes: .concurrent)

acceptQueue.async {
  while true {
    let clientFd = accept(serverFd, nil, nil)
    if clientFd < 0 {
      if errno == EINTR { continue }
      break
    }
    clientQueue.async {
      handleClient(fd: clientFd, expectedToken: config.token)
    }
  }
  VirtualStageManager.shared.teardownAll()
  cleanupSocket()
  exit(0)
}

RunLoop.main.run()
