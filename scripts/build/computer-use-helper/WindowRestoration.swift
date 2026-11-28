import CoreGraphics

func sameWindowFrame(_ first: CGRect, _ second: CGRect) -> Bool {
  abs(first.minX - second.minX) <= 2 && abs(first.minY - second.minY) <= 2
    && abs(first.width - second.width) <= 2 && abs(first.height - second.height) <= 2
}

func hasUsableWindowArea(_ frame: CGRect, on displays: [CGRect]) -> Bool {
  displays.contains { display in
    let visible = display.intersection(frame)
    return !visible.isNull && visible.width >= min(160,frame.width*0.4)
      && visible.height >= min(100,frame.height*0.4)
  }
}

func shouldRestoreAfterDisconnect(_ current: CGRect, target: CGRect, ownedFrame: CGRect, displays: [CGRect]) -> Bool {
  guard !sameWindowFrame(current,target), !displays.isEmpty else { return false }
  return sameWindowFrame(current,ownedFrame) || !hasUsableWindowArea(current,on:displays)
}

// Moving a window across displays can make the application change its size one
// run-loop turn later. Read its actual frame again before deciding to resize.
func restoreWindowFrame(
  target: CGRect,
  read: () -> CGRect?,
  apply: (CGRect) -> Void,
  wait: () -> Void
) -> CGRect? {
  var consecutiveMatches = 0
  for check in 0..<8 {
    guard let frame = read() else { return nil }
    if sameWindowFrame(frame, target) {
      consecutiveMatches += 1
      if consecutiveMatches == 3 { return frame }
    } else {
      // Give AX and the application time to apply the previous request.
      if consecutiveMatches > 0 || check % 3 == 0 { apply(target) }
      consecutiveMatches = 0
    }
    wait()
  }
  return read()
}
