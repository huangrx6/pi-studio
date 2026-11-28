const { resolveCoordinateFromOptions } = require('./act.cjs');

function targetKey(app) {
  return String(app.bundleId || app.path || app.name || '').toLowerCase();
}

function popupObservation(target, windowId, shot) {
  function geometry(items = []) {
    return items.filter(item => Number.isInteger(item.windowId) && item.bounds?.width > 0 && item.bounds.height > 0)
      .map(({ windowId, bounds }) => ({ windowId, bounds }));
  }
  return {
    target: targetKey(target), windowId: Number(windowId), bounds: shot.bounds,
    regions: geometry(shot.popupRegions), panels: geometry(shot.panels),
  };
}

function popupChanged() {
  return Object.assign(new Error('弹窗与最近一次窗口截图不匹配，请重新读取窗口后单独点击结果。'), { code: 'desktop_popup_changed' });
}

function contains(bounds, point) {
  return point && point.x >= bounds.x && point.y >= bounds.y &&
    point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;
}

function bindPopupClick(action, observation, target, windowId) {
  const explicit = action?.popupWindowId;
  const kind = String(action?.type || action?.action || '').toLowerCase();
  if (!['click', 'double_click', 'right_click'].includes(kind) || action.ref || action.elementPath || action.path) {
    if (explicit != null) throw Object.assign(new Error('独立面板仅支持坐标点击。'), { code: 'desktop_act_invalid' });
    return action;
  }
  if (observation?.windowId !== Number(windowId) || observation.target !== targetKey(target)) {
    if (explicit != null) throw popupChanged();
    return action;
  }
  // A separately returned panel image has its own coordinate system.
  if (explicit != null) {
    const panel = observation.panels.find(item => item.windowId === explicit);
    if (panel) return { ...action, popupBounds: panel.bounds };
  }

  if (explicit == null && !observation.regions.length) return action;
  const point = resolveCoordinateFromOptions(action, observation.bounds)?.point;
  const region = observation.regions.find(item => contains(item.bounds, point));
  if (explicit != null && region?.windowId !== explicit) throw popupChanged();
  if (!region || !contains(observation.bounds, point)) {
    if (explicit != null) throw popupChanged();
    return action;
  }
  // Keep exactly the point read from the main image. Native dispatch uses the
  // popup's local coordinates and verifies both its window ID and observed frame.
  const { normX, normY, imageWidth, imageHeight, x, y, ...options } = action;
  return { ...options, rx: point.x - region.bounds.x, ry: point.y - region.bounds.y,
    popupWindowId: region.windowId, popupBounds: region.bounds };
}

module.exports = { popupObservation, bindPopupClick, popupChanged };
