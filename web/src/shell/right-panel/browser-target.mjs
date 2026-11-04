/**
 * Address-bar normalisation for the in-app browser.
 *
 * Users type bare hosts far more often than full URLs, but anything with an
 * unknown scheme must be refused instead of being silently turned into a
 * search or a `file:` navigation.
 */
export function normalizeBrowserTarget(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/i.test(text) || /^localhost(:\d+)?([/?#].*)?$/i.test(text)) {
    return `https://${text}`;
  }
  return '';
}
