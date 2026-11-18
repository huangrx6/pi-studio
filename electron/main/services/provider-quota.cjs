const { normalizeProviderQuota, projectQuota, quotaConnection, quotaFieldPaths } = require('../core/provider-quota.cjs');

const MAX_BYTES = 512 * 1024;
const FRESH_MS = 60_000;
const STALE_MS = 5 * FRESH_MS;
class QuotaError extends Error {
  constructor(message, transient = false) { super(message); this.transient = transient; }
}

async function readQuotaJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new QuotaError('额度接口返回内容过大。');
  if (!response.body) throw new QuotaError('额度接口返回了空内容。');
  const parts = [];
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new QuotaError('额度接口返回内容过大。');
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new QuotaError('额度接口未返回有效的 JSON。'); }
}

function statusError(status) {
  if (status === 401 || status === 403) return new QuotaError(`认证失败（HTTP ${status}），请检查来源凭据与额度接口权限。`);
  if (status === 429) return new QuotaError('查询过于频繁，请稍后刷新。', true);
  return new QuotaError(`额度接口返回 HTTP ${status}。`, status >= 500);
}

function createProviderQuotaMonitor({ getProvider, readKey, isAvailable = () => true, fetcher = globalThis.fetch, clock = Date.now }) {
  const entries = new Map();

  function invalidate(id) {
    entries.get(id)?.controller?.abort();
    entries.delete(id);
  }

  async function queryEndpoint(config, controller, getKey, project) {
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const headers = { Accept: 'application/json', ...Object.fromEntries((config.headers || []).map(row => [row.name, row.value])) };
      let endpoint = config.endpoint;
      let key = '';
      if (config.auth !== 'none') {
        try { key = await getKey(); }
        catch (error) {
          if (error instanceof QuotaError) throw error;
          throw new QuotaError('无法读取此来源的凭据。');
        }
        if (!key) throw new QuotaError('请先填写此来源的 API Key。');
        if (config.auth === 'bearer') headers.Authorization = `Bearer ${key}`;
        else if (config.auth === 'authorization') headers.Authorization = key;
        else if (config.auth === 'query') {
          const url = new URL(endpoint);
          url.searchParams.set(config.authName, key);
          endpoint = url.href;
        } else headers[config.auth === 'custom-header' ? config.authName : config.auth] = key;
      }
      controller.signal.throwIfAborted();
      const response = await fetcher(endpoint, { method: 'GET', headers, redirect: 'error', signal: controller.signal });
      if (!response.ok) throw statusError(response.status);
      const data = await readQuotaJson(response);
      // BigModel and some gateways report authentication failures inside HTTP 200.
      // Never return their message: it may echo the key or authenticated URL.
      if (data?.success === false) {
        if ([401, 403, 1000].includes(Number(data.code))) throw new QuotaError('认证失败，请检查来源凭据与额度接口权限。');
        throw new QuotaError('额度接口报告查询失败，请检查套餐状态、接口权限与请求参数。');
      }
      return project(data, key);
    } catch (error) {
      if (error instanceof QuotaError) throw error;
      throw new QuotaError(controller.signal.aborted ? '额度查询超时，请重试。' : '无法连接额度接口，请检查地址和网络。', true);
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  function inspect(id, draft) {
    if (!isAvailable()) throw new QuotaError('请先启用额度状态扩展。');
    const connection = quotaConnection(draft);
    const provider = getProvider(id);
    // Draft endpoints may use a freshly entered key. A saved credential can
    // only be probed on a destination already configured for this provider.
    const getKey = () => {
      if (typeof draft.apiKey === 'string' && draft.apiKey.trim()) return draft.apiKey.trim();
      const origin = new URL(connection.endpoint).origin;
      const destinations = [provider?.baseUrl, provider?.quota?.auth !== 'none' && provider?.quota?.endpoint];
      if (!destinations.some(url => url && URL.canParse(url) && new URL(url).origin === origin)) {
        throw new QuotaError('使用已保存的密钥读取新域名时，请先保存额度接口，或在上方重新填写 API Key。');
      }
      return readKey(id);
    };
    return queryEndpoint(connection, new AbortController(), getKey, quotaFieldPaths);
  }

  async function read(id, force = false) {
    const provider = getProvider(id);
    if (!provider?.enabled || !provider.quota?.enabled || !isAvailable()) {
      invalidate(id);
      return { status: 'disabled', metrics: [] };
    }
    const config = normalizeProviderQuota(provider.quota);
    const signature = JSON.stringify(config);
    let entry = entries.get(id);
    if (entry?.signature !== signature) {
      invalidate(id);
      entry = { signature };
      entries.set(id, entry);
    }
    if (entry.pending) return entry.pending;
    if (!force && entry.snapshot && clock() < entry.nextRead) return entry.snapshot;
    const controller = new AbortController();
    entry.controller = controller;
    const query = async () => {
      try {
        const metrics = await queryEndpoint(config, controller, () => readKey(id), (data, key) => projectQuota(config.fields, data, key));
        const updatedAt = clock();
        const status = metrics.some(metric => metric.value !== null) ? 'ready' : 'unmapped';
        const result = { status, metrics, updatedAt };
        entry.success = status === 'ready' ? result : undefined;
        return result;
      } catch (error) {
        const transient = error instanceof QuotaError && error.transient;
        const message = error instanceof QuotaError ? error.message : '额度查询失败。';
        if (transient && entry.success && clock() - entry.success.updatedAt <= STALE_MS) {
          return { ...entry.success, status: 'stale', message };
        }
        entry.success = undefined;
        return { status: 'error', metrics: [], message };
      }
    };
    entry.pending = query().then(snapshot => {
      if (entries.get(id) !== entry || !isAvailable()) return { status: 'disabled', metrics: [] };
      entry.snapshot = snapshot;
      entry.nextRead = clock() + ((snapshot.status === 'error' || snapshot.status === 'stale') ? 15_000 : FRESH_MS);
      return snapshot;
    }).finally(() => { entry.pending = undefined; entry.controller = undefined; });
    return entry.pending;
  }
  return { read, inspect, invalidate };
}

module.exports = { createProviderQuotaMonitor };
