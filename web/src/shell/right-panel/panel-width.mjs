export const DEFAULT_PANEL_WIDTH = 390;
export const MIN_PANEL_WIDTH = 320;

export function normalizePanelWidth(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_PANEL_WIDTH
    ? Math.round(value)
    : DEFAULT_PANEL_WIDTH;
}

/** Below 1100px the existing panel is an overlay; above it reserve a usable chat column. */
export function maximumPanelWidth(viewportWidth, sidebarWidth) {
  return Math.max(MIN_PANEL_WIDTH, Math.floor(viewportWidth <= 1100
    ? viewportWidth - 48
    : viewportWidth - sidebarWidth - 480));
}
