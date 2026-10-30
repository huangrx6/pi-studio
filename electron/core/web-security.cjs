/**
 * Renderer navigation and Content-Security-Policy policy.
 *
 * Keeping URL decisions in a dependency-free module makes the Electron window
 * wiring reviewable and testable without booting Chromium.
 */

function rendererContentSecurityPolicy({ dev = false } = {}) {
  const scriptSources = dev ? "'self' 'unsafe-eval'" : "'self'";
  const connectSources = dev
    ? "'self' http://127.0.0.1:5180 ws://127.0.0.1:5180"
    : "'self'";
  return [
    "default-src 'none'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: pi-media: https: http:",
    "media-src 'self' data: blob: pi-media:",
    "font-src 'self' data:",
    `connect-src ${connectSources}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function isTrustedRendererUrl(value, { dev = false, devUrl, productionUrl } = {}) {
  let parsed;
  let expected;
  try {
    parsed = new URL(value);
    expected = new URL(dev ? devUrl : productionUrl);
  } catch {
    return false;
  }
  if (dev) return parsed.origin === expected.origin;
  return parsed.protocol === 'file:' && parsed.href === expected.href;
}

module.exports = {
  isTrustedRendererUrl,
  rendererContentSecurityPolicy,
};
