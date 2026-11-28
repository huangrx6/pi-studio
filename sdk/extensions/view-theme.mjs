/** Public CSS roles sent to sandboxed views in pi-studio:ext-view:v1 host:context. */
export const studioViewTokens = Object.freeze([
  '--surface-canvas', '--surface-chrome', '--surface-raised', '--surface-floating',
  '--bg', '--surface', '--surface-hover', '--sidebar-bg', '--composer-surface',
  '--dialog-surface', '--overlay-surface', '--inline-code-bg', '--tint-neutral',
  '--nav-hover-bg', '--nav-selected-bg', '--nav-selected-hover-bg', '--selection', '--selection-text',
  '--text', '--text-1', '--text-2', '--text-3', '--muted', '--faint', '--disabled-text', '--link',
  '--border', '--border-strong', '--border-hover', '--divider', '--focus-color',
  '--accent', '--accent-soft', '--accent-border', '--accent-tint', '--button-bg', '--button-hover', '--on-button',
  '--info', '--info-soft', '--info-border', '--success', '--success-soft', '--success-border',
  '--warning', '--warning-soft', '--warning-border', '--error', '--error-soft', '--error-border',
  '--scrim', '--scrollbar', '--scrollbar-hover', '--shadow-float', '--shadow-deep', '--shadow-dialog',
  '--syntax-comment', '--syntax-keyword', '--syntax-string', '--syntax-number', '--syntax-function',
  '--font', '--mono', '--font-mono',
  '--text-display', '--text-title', '--text-heading', '--text-subtitle', '--text-body',
  '--text-label', '--text-description', '--text-caption', '--text-code', '--text-metric',
  '--icon-2xs', '--icon-xs', '--icon-sm', '--icon-md', '--icon-lg', '--icon-xl',
  '--weight-regular', '--weight-medium', '--weight-semibold', '--weight-bold',
  '--leading-tight', '--leading-normal', '--leading-body', '--leading-relaxed',
  '--radius-control', '--radius-card', '--radius-panel', '--radius-tag',
]);

/** Apply a context received from the parent Studio window to the plugin document. */
export function applyStudioTheme({ theme, tokens }, root = document.documentElement) {
  const scheme = theme === 'dark' ? 'dark' : 'light';
  root.dataset.theme = scheme;
  root.style.colorScheme = scheme;
  for (const name of studioViewTokens) {
    const value = tokens?.[name];
    if (typeof value === 'string' && value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  return scheme;
}
