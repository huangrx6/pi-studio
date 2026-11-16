/** Electron supplies the host platform before the first paint. Browser previews use their own OS. */
export function desktopPlatform(): string {
  const native = typeof window !== 'undefined' && window.piApi?.platform;
  if (typeof native === 'string' && native) return native;
  const browser = typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent;
  if (/^Win/i.test(browser) || /Windows/i.test(browser)) return 'win32';
  if (/Mac|iPhone|iPad/i.test(browser)) return 'darwin';
  return '';
}

export function revealFileLabel(): string {
  switch (desktopPlatform()) {
    case 'win32': return '在文件资源管理器中显示';
    case 'darwin': return '在 Finder 中显示';
    default: return '显示文件位置';
  }
}
