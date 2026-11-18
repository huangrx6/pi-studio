'use strict';

const { getStudioDatabase } = require('./studio-db.cjs');

const NETWORK_SETTINGS_KEY = 'studio.network.proxy';
const DEFAULT_NETWORK_SETTINGS = Object.freeze({ mode: 'system', proxyUrl: '', bypassRules: '' });

function normalizeProxyUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('请输入有效的代理地址');
  const text = value.trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw new Error('代理地址格式不正确，例如 http://127.0.0.1:7897'); }
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol)) throw new Error('代理协议仅支持 HTTP、HTTPS 和 SOCKS5');
  if (url.username || url.password) throw new Error('暂不支持需要用户名或密码的代理，请使用本机无需认证的代理入口');
  if (!url.hostname || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('代理地址只应包含协议、主机和端口');
  }
  if (/[\s;,=]/.test(text)) throw new Error('代理地址不能包含空格或代理规则');
  const port = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '1080');
  if (Number(port) < 1 || Number(port) > 65535) throw new Error('代理端口应在 1–65535 之间');
  return `${url.protocol}//${url.hostname}:${port}`;
}

function normalizeNetworkSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('代理设置格式不正确');
  if (!['system', 'manual', 'direct'].includes(value.mode)) throw new Error('请选择有效的代理模式');
  let proxyUrl = '', bypassRules = '';
  try { proxyUrl = normalizeProxyUrl(value.proxyUrl ?? ''); }
  catch (error) { if (value.mode === 'manual') throw error; }
  try { bypassRules = normalizeBypassRules(value.bypassRules ?? ''); }
  catch (error) { if (value.mode === 'manual') throw error; }
  // Hidden, unused manual drafts must not prevent switching back to system or
  // direct mode. Keep only valid values for a later return to manual mode.
  if (value.mode === 'manual' && !proxyUrl) throw new Error('手动配置需要填写代理地址');
  return { mode: value.mode, proxyUrl, bypassRules };
}

function normalizeBypassRules(bypass) {
  if (typeof bypass !== 'string' || bypass.length > 2048 || /[\x00-\x1f]/.test(bypass)) {
    throw new Error('不使用代理的地址格式不正确');
  }
  // Keep bypasses to host/IP patterns. Never allow <-loopback> to send local
  // model traffic to a remote proxy by disabling Chromium's implicit bypass.
  const rules = bypass.split(/[,;]/).map(rule => rule.trim()).filter(Boolean);
  if (rules.some(rule => !/^[a-zA-Z0-9.*_:[\]/-]+$/.test(rule) && rule !== '<local>')) {
    throw new Error('例外地址请使用域名或 IP，以逗号分隔，例如 localhost, *.local, 192.168.0.0/16');
  }
  return [...new Set(rules)].join(', ');
}

function getNetworkSettings() {
  return getStudioDatabase().getSettingWithRecovery(
    NETWORK_SETTINGS_KEY, DEFAULT_NETWORK_SETTINGS, value => {
      try { return normalizeNetworkSettings(value); }
      catch { return { ...DEFAULT_NETWORK_SETTINGS }; }
    },
  );
}

function saveNetworkSettings(value) {
  const next = normalizeNetworkSettings(value);
  getStudioDatabase().setSetting(NETWORK_SETTINGS_KEY, next);
  return next;
}

function proxyConfig(settings) {
  if (settings.mode !== 'manual') return { mode: settings.mode };
  return {
    mode: 'fixed_servers',
    proxyRules: settings.proxyUrl,
    proxyBypassRules: ['localhost', '127.0.0.1', '[::1]', settings.bypassRules].filter(Boolean).join(','),
  };
}

module.exports = {
  DEFAULT_NETWORK_SETTINGS, NETWORK_SETTINGS_KEY, normalizeProxyUrl,
  normalizeNetworkSettings, getNetworkSettings, saveNetworkSettings, proxyConfig,
};
