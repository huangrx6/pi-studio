// Native bounds include the 12 CSS px shadow gutter on each side of the panel.
const GUTTERS = 24;
const MIN_WIDTH = 320 + GUTTERS;
const MIN_HEIGHT = 200 + GUTTERS;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function centeredOrigin(area, width, height) {
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) * .43),
  };
}

function fitToolBounds(area, placement, maximized) {
  const { x, y, width, height, zoom } = area;
  if (maximized) return { x, y, width, height };
  const gutter = GUTTERS * zoom;
  const defaultWidth = clamp(width * .77, 500 * zoom, 920 * zoom);
  const contentWidth = Math.min(defaultWidth, Math.max(0, width - gutter));
  const defaultHeight = clamp(Math.min(height * .56, contentWidth * 560 / 920), 300 * zoom, 560 * zoom);
  const preferredWidth = placement.width === undefined ? defaultWidth + gutter : Math.max(MIN_WIDTH, placement.width) * zoom;
  const preferredHeight = placement.height === undefined ? defaultHeight + gutter : Math.max(MIN_HEIGHT, placement.height) * zoom;
  const panelWidth = Math.min(width, Math.round(preferredWidth));
  const panelHeight = Math.min(height, Math.round(preferredHeight));
  const center = centeredOrigin(area, panelWidth, panelHeight);
  return {
    x: clamp(center.x + Math.round(placement.offsetX * zoom), x, x + width - panelWidth),
    y: clamp(center.y + Math.round(placement.offsetY * zoom), y, y + height - panelHeight),
    width: panelWidth, height: panelHeight,
  };
}

function dragToolBounds(area, start, handle, dx, dy) {
  if (handle === 'move') return {
    ...start,
    x: clamp(start.x + dx, area.x, area.x + area.width - start.width),
    y: clamp(start.y + dy, area.y, area.y + area.height - start.height),
  };
  const minWidth = Math.min(area.width, Math.round(MIN_WIDTH * area.zoom));
  const minHeight = Math.min(area.height, Math.round(MIN_HEIGHT * area.zoom));
  let { x, y } = start;
  let right = x + start.width;
  let bottom = y + start.height;
  if (handle.includes('w')) x = clamp(x + dx, area.x, right - minWidth);
  if (handle.includes('e')) right = clamp(right + dx, x + minWidth, area.x + area.width);
  if (handle.includes('n')) y = clamp(y + dy, area.y, bottom - minHeight);
  if (handle.includes('s')) bottom = clamp(bottom + dy, y + minHeight, area.y + area.height);
  return { x, y, width: right - x, height: bottom - y };
}

function placementForBounds(area, bounds, previous, handle) {
  const center = centeredOrigin(area, bounds.width, bounds.height);
  return {
    width: handle === 'move' ? previous.width : bounds.width / area.zoom,
    height: handle === 'move' ? previous.height : bounds.height / area.zoom,
    offsetX: (bounds.x - center.x) / area.zoom,
    offsetY: (bounds.y - center.y) / area.zoom,
  };
}

module.exports = { fitToolBounds, dragToolBounds, placementForBounds };
