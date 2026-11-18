'use strict';

const { createHash } = require('node:crypto');
const {
  getNetworkSettings, saveNetworkSettings, normalizeNetworkSettings, normalizeProxyUrl, proxyConfig,
} = require('../core/network-settings.cjs');
const { installSystemFetch } = require('../core/http-fetch.cjs');

const PROBE_URL = 'https://www.google.com/generate_204';
const PROBE_TIMEOUT_MS = 15_000;

function detectedProxyUrl(route) {
  const first = route.split(';')[0].trim();
  const match = /^(PROXY|HTTPS|SOCKS5)\s+(\S+)$/i.exec(first);
  if (!match) return '';
  const protocol = { PROXY: 'http', HTTPS: 'https', SOCKS5: 'socks5' }[match[1].toUpperCase()];
  try { return normalizeProxyUrl(`${protocol}://${match[2]}`); } catch { return ''; }
}

function safeRoute(value) {
  // A system PAC is external input. Only expose proxy destinations, never
  // possible userinfo, PAC source URLs or arbitrary diagnostic text.
  return String(value).split(';').map(part => {
    const item = part.trim();
    if (item === 'DIRECT') return item;
    // PAC's SOCKS means SOCKS4, not SOCKS5. Display it without offering an
    // incompatible manual SOCKS5 address.
    if (/^SOCKS\s+\S+$/i.test(item)) {
      try {
        const url = normalizeProxyUrl(`socks5://${item.replace(/^SOCKS\s+/i, '')}`);
        return url.replace('socks5:', 'socks4:');
      } catch { return '未知代理'; }
    }
    const url = detectedProxyUrl(item);
    return url || '未知代理';
  }).join(' → ');
}

function createNetworkService({
  sessionForPartition,
  readSettings = getNetworkSettings,
  writeSettings = saveNetworkSettings,
  probeUrl = PROBE_URL,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const sessions = new Map();
  let active;
  let writeTail = Promise.resolve();

  function transportFor(settings) {
    const config = proxyConfig(settings);
    const key = JSON.stringify(config);
    if (!sessions.has(key)) {
      // Immutable proxy configuration per session: saving a new route never
      // closes an in-flight response or reuses the previous route's sockets.
      // Reuse the same partition when revisiting an existing configuration.
      const partition = 'pi-studio-network-' + createHash('sha256').update(key).digest('hex');
      const pending = (async () => {
        const session = sessionForPartition(partition, { cache: false });
        await session.setProxy(config);
        return session;
      })();
      sessions.set(key, pending);
      void pending.catch(() => { if (sessions.get(key) === pending) sessions.delete(key); });
    }
    return sessions.get(key);
  }

  async function initialize() {
    const settings = readSettings();
    const session = await transportFor(settings);
    if (!active) active = { settings, session };
  }

  async function fetch(input, init) {
    if (!active) await initialize();
    const session = active.session;
    return session.fetch(input, { ...init, credentials: 'omit' });
  }

  async function snapshot() {
    if (!active) await initialize();
    return { ...active.settings };
  }

  function save(value) {
    const settings = normalizeNetworkSettings(value);
    const pending = writeTail.then(async () => {
      const session = await transportFor(settings);
      // Preparation may fail; only commit after the new transport is ready.
      writeSettings(settings);
      active = { settings, session };
      return { ...settings };
    });
    writeTail = pending.catch(() => {});
    return pending;
  }

  async function inspect(value, testConnection = false) {
    const settings = normalizeNetworkSettings(value);
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('连接超时，请确认代理已启动，并检查代理地址和网络线路。'));
      }, timeoutMs);
      timer.unref?.();
    });
    let finished = false;
    try {
      return await Promise.race([timeout, (async () => {
        const session = await transportFor(settings);
        if (settings.mode === 'system') await session.forceReloadProxyConfig();
        const route = await session.resolveProxy(probeUrl);
        if (finished || controller.signal.aborted) return;
        const result = { target: probeUrl, route: safeRoute(route), detectedProxyUrl: detectedProxyUrl(route) };
        if (!testConnection) return result;
        const started = Date.now();
        const response = await session.fetch(probeUrl, {
          method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
        });
        void response.body?.cancel().catch(() => {});
        return { ...result, ok: response.ok, status: response.status, latencyMs: Date.now() - started };
      })()]);
    } catch (error) {
      if (controller.signal.aborted) throw new Error('连接超时，请确认代理已启动，并检查代理地址和网络线路。');
      const code = String(error?.message || '').match(/net::ERR_[A-Z_]+/)?.[0];
      throw new Error(code
        ? `连接失败（${code}），请检查代理服务和网络线路。`
        : '无法完成网络检查，请检查代理配置后重试。');
    } finally {
      finished = true;
      clearTimeout(timer);
    }
  }

  return { initialize, fetch, snapshot, save, inspect };
}

let service;
function networkService() {
  if (!service) service = createNetworkService({
    sessionForPartition: (...args) => require('electron').session.fromPartition(...args),
  });
  return service;
}

async function initializeNetwork() {
  const network = networkService();
  await network.initialize();
  // Install before loading provider SDKs. Their default fetch (including OAuth,
  // model discovery and downloads) then uses the same Studio network policy.
  installSystemFetch(network.fetch);
}

module.exports = { createNetworkService, initializeNetwork, networkService, PROBE_URL };
