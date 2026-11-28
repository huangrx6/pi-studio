import AppKit

// A delayed suggestion drawn either in an owned panel or inside the window.
// Losing the key window or moving to another display dismisses both variants.
final class SearchFixture: NSObject, NSApplicationDelegate, NSSearchFieldDelegate, NSWindowDelegate {
  let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 410, height: 190),
                        styleMask: [.titled, .closable], backing: .buffered, defer: false)
  let panel = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 275, height: 85),
                      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
  let input = NSSearchField(frame: CGRect(x: 24, y: 130, width: 340, height: 30))
  let inline = NSTextField(labelWithString: "Inline suggestion: Orbit")
  let stateURL = URL(fileURLWithPath: CommandLine.arguments[1])
  var delay: Timer?
  var blurred = 0
  var ready = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    let menu = NSMenu()
    let appMenu = NSMenuItem()
    menu.addItem(appMenu)
    appMenu.submenu = NSMenu(title: "Fixture")
    let edit = NSMenuItem()
    menu.addItem(edit)
    edit.submenu = NSMenu(title: "Edit")
    edit.submenu?.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    NSApp.mainMenu = menu
    window.title = "Pi Studio dropdown fixture"
    window.center()
    window.delegate = self
    input.delegate = self
    window.contentView?.addSubview(input)
    inline.frame = CGRect(x: 26, y: 62, width: 310, height: 35)
    inline.isHidden = true
    window.contentView?.addSubview(inline)
    let item = NSTextField(labelWithString: "Detached suggestion: Harbor")
    item.frame = CGRect(x: 12, y: 25, width: 245, height: 32)
    panel.contentView?.addSubview(item)
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = true
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    window.makeFirstResponder(input)
    ready = true
    report()
  }

  func report() {
    guard ready else { return }
    let state: [String: Any] = ["windowId": window.windowNumber, "panelId": panel.windowNumber,
      "key": window.isKeyWindow, "frame": NSStringFromRect(window.frame), "blurred": blurred,
      "text": input.stringValue, "panelVisible": panel.isVisible, "inlineVisible": !inline.isHidden]
    if let data = try? JSONSerialization.data(withJSONObject: state) { try? data.write(to: stateURL, options: .atomic) }
  }

  func dismiss() {
    delay?.invalidate()
    if panel.parent === window { window.removeChildWindow(panel) }
    if panel.isVisible { panel.orderOut(nil) }
    inline.isHidden = true
    report()
  }

  func windowDidBecomeKey(_ notification: Notification) { report() }
  func windowDidResignKey(_ notification: Notification) { blurred += 1; dismiss() }
  func windowDidChangeScreen(_ notification: Notification) { dismiss() }
  func controlTextDidChange(_ notification: Notification) {
    dismiss()
    delay = Timer.scheduledTimer(withTimeInterval: 0.48, repeats: false) { [self] _ in
      guard window.isKeyWindow else { return }
      if input.stringValue == "inline" {
        inline.isHidden = false
      } else if input.stringValue == "panel" {
        panel.setFrameOrigin(NSPoint(x: window.frame.maxX - 95, y: window.frame.midY - 45))
        window.addChildWindow(panel, ordered: .above)
        panel.orderFront(nil)
      }
      report()
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixture = SearchFixture()
app.delegate = fixture
app.run()
