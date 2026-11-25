export const DEFAULT_PANEL_WIDTH = 390;
export const MIN_PANEL_WIDTH = 320;
export const MIN_SPLIT_PANEL_WIDTH = 560;
export const MAX_SPLIT_PANEL_WIDTH = 760;

export function normalizePanelWidth(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_PANEL_WIDTH
    ? Math.round(value)
    : DEFAULT_PANEL_WIDTH;
}

/** Split browsing needs room for both panes and the persistent panel tools. */
export function splitPanelWidth(panelWidth: number, panelMaxWidth: number) {
  const preferred = normalizePanelWidth(panelWidth);
  const maximum = typeof panelMaxWidth === 'number' && Number.isFinite(panelMaxWidth)
    ? Math.max(MIN_PANEL_WIDTH, Math.round(panelMaxWidth))
    : DEFAULT_PANEL_WIDTH;
  return Math.min(maximum, MAX_SPLIT_PANEL_WIDTH, Math.max(MIN_SPLIT_PANEL_WIDTH, preferred));
}

export function panelUsesOverlay(viewportWidth: number, sidebarWidth: number) {
  return viewportWidth - sidebarWidth < MIN_PANEL_WIDTH + 360;
}

export function maximumPanelWidth(viewportWidth: number, sidebarWidth: number) {
  return Math.max(MIN_PANEL_WIDTH, Math.floor(panelUsesOverlay(viewportWidth, sidebarWidth)
    ? viewportWidth - 48
    : viewportWidth - sidebarWidth - 480));
}
