// These checks run in the same osascript process that posts physical input.
const JXA_TARGET_WINDOW_GUARD = `
ObjC.import('ApplicationServices');
function activePid() {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.001));
  return Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
}
function overviewIsOpen() {
  // Only inspect the system UI's top-level identifiers. Window thumbnails
  // and titles are not needed. macOS 27 exposes mc.display in WindowManager.
  function attribute(element, name) {
    var value = Ref();
    return $.AXUIElementCopyAttributeValue(element, $(name), value) === 0
      ? ObjC.castRefToObject(value[0]) : null;
  }
  return ['com.apple.dock', 'com.apple.WindowManager'].some(function (bundleId) {
    var owner = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId).firstObject;
    if (!owner || owner.isNil()) return false;
    var root = $.AXUIElementCreateApplication(owner.processIdentifier);
    $.AXUIElementSetMessagingTimeout(root, 0.15);
    var children = attribute(root, 'AXChildren');
    if (!children) return false;
    for (var i = 0; i < Number(children.count); i++) {
      var identifier = attribute(children.objectAtIndex(i), 'AXIdentifier');
      if (!identifier) continue;
      var id = String(ObjC.unwrap(identifier));
      if (id === 'mc' || id === 'mc.display') return true;
    }
    return false;
  });
}
function requireForeground(target) {
  if (overviewIsOpen()) throw new Error('desktop_mission_control_active');
  if (!target || activePid() !== target.pid) throw new Error('desktop_foreground_required');
}
function assertTargetFrontWindow(target, windowId) {
  requireForeground(target);
  var info = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0);
  var rows = ObjC.deepUnwrap(ObjC.castRefToObject(info)) || [];
  var front = rows.find(function (w) {
    return Number(w.kCGWindowOwnerPID) === target.pid && Number(w.kCGWindowLayer) === 0 && Number(w.kCGWindowAlpha) > 0;
  });
  if (!front || Number(front.kCGWindowNumber) !== windowId) throw new Error('desktop_foreground_required');
}
function hitTarget(windowId, x, y, targetPid) {
  $.NSApplication.sharedApplication;
  var primaryHeight = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
  var point = $.NSMakePoint(x, primaryHeight - y);
  var hit = Number($.NSWindow.windowNumberAtPointBelowWindowWithWindowNumber(point, 0));
  if (hit === windowId) return true;
  if (!hit || !targetPid) return false;
  var info = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0);
  var rows = ObjC.deepUnwrap(ObjC.castRefToObject(info)) || [];
  var matched = rows.find(function (w) { return Number(w.kCGWindowNumber) === hit; });
  if (!matched || Number(matched.kCGWindowOwnerPID) !== Number(targetPid)) return false;
  if (Number(matched.kCGWindowAlpha) <= 0) return false;
  var layer = Number(matched.kCGWindowLayer) || 0;
  if (layer > 0) return true;
  // Allow borderless untitled child popups/dropdowns (e.g. Qt search results) smaller than main window.
  var title = String(matched.kCGWindowName || '').trim();
  if (title) return false;
  var mainWin = rows.find(function (w) { return Number(w.kCGWindowNumber) === windowId; });
  if (!mainWin || !mainWin.kCGWindowBounds || !matched.kCGWindowBounds) return false;
  var mb = mainWin.kCGWindowBounds;
  var hb = matched.kCGWindowBounds;
  return (Number(hb.Width) || 0) < (Number(mb.Width) || 0) && (Number(hb.Height) || 0) < (Number(mb.Height) || 0);
}
`;

function foregroundError(cause) {
  const detail = String(cause?.stderr || cause?.message || '');
  const match = /(?:^|Error: )(desktop_foreground_required|desktop_mission_control_active)(?=\s|$|[:(])/u.exec(detail);
  if (!match) return;
  const error = new Error(match[1] === 'desktop_mission_control_active'
    ? '调度中心正在显示窗口概览，已暂停需要前台鼠标或键盘的操作。退出概览后请重新观察原窗口。'
    : '目标窗口未在前台或输入位置被遮挡。可继续读取原窗口或使用它的辅助功能控件；需要实际键鼠时请切回该窗口。', { cause });
  error.code = match[1];
  return error;
}

module.exports = { JXA_TARGET_WINDOW_GUARD, foregroundError };
