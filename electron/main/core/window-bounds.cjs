/**
 * Main-window geometry.
 *
 * The renderer never sees these values; the main process restores the last
 * window bounds and falls back to a centered default when the saved rectangle
 * no longer fits any display (unplugged monitor, resolution change). Kept free
 * of Electron imports so the placement rules can be tested without a desktop.
 */

const DEFAULT_WINDOW_SIZE = Object.freeze({ width: 1440, height: 920 });
const MIN_WINDOW_SIZE = Object.freeze({ width: 980, height: 640 });

function isFiniteRect(value) {
  return Boolean(value)
    && typeof value === 'object'
    && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key]))
    && value.width > 0
    && value.height > 0;
}

function roundRect(rect) {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** Saved bounds are only trusted when they can still hold the minimum window. */
function normalizeWindowBounds(value) {
  if (!isFiniteRect(value)) return null;
  const width = Math.round(value.width);
  const height = Math.round(value.height);
  if (width < MIN_WINDOW_SIZE.width || height < MIN_WINDOW_SIZE.height) return null;
  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
    width,
    height,
    maximized: value.maximized === true,
  };
}

function normalizeWorkAreas(workAreas) {
  const list = Array.isArray(workAreas) ? workAreas : [];
  return list.filter(isFiniteRect).map(roundRect);
}

function overlapArea(rect, area) {
  const width = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
  const height = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Keep the window inside one work area and never below the minimum size. */
function fitIntoArea(rect, area) {
  const width = clamp(rect.width, MIN_WINDOW_SIZE.width, Math.max(area.width, MIN_WINDOW_SIZE.width));
  const height = clamp(rect.height, MIN_WINDOW_SIZE.height, Math.max(area.height, MIN_WINDOW_SIZE.height));
  return {
    x: Math.round(clamp(rect.x, area.x, area.x + Math.max(area.width - width, 0))),
    y: Math.round(clamp(rect.y, area.y, area.y + Math.max(area.height - height, 0))),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** First launch, or a stale saved rectangle: open a centered default window. */
function centerWindowBounds(area) {
  const target = isFiniteRect(area) ? roundRect(area) : { x: 0, y: 0, ...DEFAULT_WINDOW_SIZE };
  const fitted = fitIntoArea({ x: target.x, y: target.y, ...DEFAULT_WINDOW_SIZE }, target);
  return fitIntoArea({
    x: target.x + Math.round((target.width - fitted.width) / 2),
    y: target.y + Math.round((target.height - fitted.height) / 2),
    width: fitted.width,
    height: fitted.height,
  }, target);
}

/**
 * Restore the saved rectangle when it still overlaps a connected display,
 * otherwise center a default window. The first work area is the primary one.
 */
function resolveWindowBounds(saved, workAreas) {
  const areas = normalizeWorkAreas(workAreas);
  const stored = normalizeWindowBounds(saved);
  if (stored && areas.length > 0) {
    let target = null;
    let bestOverlap = 0;
    for (const area of areas) {
      const overlap = overlapArea(stored, area);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        target = area;
      }
    }
    if (target) {
      return {
        bounds: fitIntoArea(stored, target),
        maximized: stored.maximized,
        restored: true,
      };
    }
  }
  return {
    bounds: centerWindowBounds(areas[0]),
    maximized: false,
    restored: false,
  };
}

module.exports = {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  centerWindowBounds,
  normalizeWindowBounds,
  resolveWindowBounds,
};
