/**
 * Address-bar normalisation for the in-app browser.
 *
 * Users type bare hosts far more often than full URLs. Local HTML is also a
 * supported explicit target, while other schemes are refused instead of being
 * silently turned into a search or a `file:` navigation.
 */
export function normalizeBrowserTarget(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (/^file:\/\//i.test(text)) {
    try {
      const target = new URL(text);
      const pathname = decodeURIComponent(target.pathname || '');
      if (target.protocol === 'file:' && /\.html?$/i.test(pathname)) return target.href;
    } catch {
      // Fall through to the normal invalid-target result.
    }
    return '';
  }
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/i.test(text) || /^localhost(:\d+)?([/?#].*)?$/i.test(text)) {
    return `https://${text}`;
  }
  return '';
}
