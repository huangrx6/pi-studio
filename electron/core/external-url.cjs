/**
 * Parse URLs before handing them to Electron or the operating system.
 *
 * External links are limited to credential-free HTTP(S) URLs. Returning the
 * canonical URL also prevents shell-specific prefixes and control characters
 * from surviving the validation boundary.
 */

const DEFAULT_MAX_URL_LENGTH = 2_048;

function normalizeExternalHttpUrl(value, maxLength = DEFAULT_MAX_URL_LENGTH) {
  if (typeof value !== 'string') {
    throw new Error('链接必须是字符串');
  }
  const input = value.trim();
  if (!input) throw new Error('链接不能为空');
  if (input.length > maxLength) throw new Error(`链接不能超过 ${maxLength} 个字符`);
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new Error('链接包含无效控制字符');

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('链接格式无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只允许打开 HTTP 或 HTTPS 链接');
  }
  if (!parsed.hostname) throw new Error('链接缺少有效主机名');
  if (parsed.username || parsed.password) {
    throw new Error('链接不能包含用户名或密码');
  }
  return parsed.href;
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

/**
 * Remote service endpoints must use HTTPS. Plain HTTP is retained only for
 * loopback development servers, and fragments are discarded because they are
 * not sent to the service.
 */
function normalizeSecureHttpUrl(value, options = {}) {
  const label = typeof options.label === 'string' && options.label.trim()
    ? options.label.trim()
    : '服务地址';
  const normalized = normalizeExternalHttpUrl(
    value,
    Number.isFinite(options.maxLength) ? options.maxLength : DEFAULT_MAX_URL_LENGTH,
  );
  const parsed = new URL(normalized);
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(`${label}必须使用 HTTPS；仅本机回环地址可使用 HTTP`);
  }
  parsed.hash = '';
  return parsed.href;
}

module.exports = {
  DEFAULT_MAX_URL_LENGTH,
  isLoopbackHostname,
  normalizeExternalHttpUrl,
  normalizeSecureHttpUrl,
};
