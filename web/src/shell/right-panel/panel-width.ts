export const DEFAULT_PANEL_WIDTH = 390;
export const MIN_PANEL_WIDTH = 320;

export function normalizePanelWidth(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_PANEL_WIDTH
    ? Math.round(value)
    : DEFAULT_PANEL_WIDTH;
}

export function panelUsesOverlay(viewportWidth: number, sidebarWidth: number) {
  return viewportWidth - sidebarWidth < MIN_PANEL_WIDTH + 360;
}

export function maximumPanelWidth(viewportWidth: number, sidebarWidth: number) {
  return Math.max(MIN_PANEL_WIDTH, Math.floor(panelUsesOverlay(viewportWidth, sidebarWidth)
    ? viewportWidth - 48
    : viewportWidth - sidebarWidth - 480));
}
