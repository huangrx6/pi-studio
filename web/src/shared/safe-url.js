/**
 * Return a safe image URL, or an empty string when Markdown contains a source
 * that could escape the renderer's intended image protocols.
 */
export function safeMarkdownImageSource(value) {
  if (typeof value !== 'string') return '';
  const input = value.trim();
  if (!input || input.length > 16 * 1024 * 1024 || /[\u0000-\u001f\u007f]/.test(input)) return '';

  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(input)) {
    return input;
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return '';
  }
  if (parsed.username || parsed.password) return '';
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  if (parsed.protocol === 'pi-media:' && parsed.hostname === 'background') return parsed.href;
  return '';
}
