import { MONITOR_REFRESH_MS, STALE_KEEP_MS } from './types.mjs';
import { adapterMatchesBaseUrl } from './adapters.mjs';
import { quotaContent } from './ui.mjs';

function describeFetchError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    (error instanceof Error && error.name === 'TimeoutError')
    || /timeout|timed out|aborted/i.test(message)
  ) return '请求超时';
  if (/^HTTP 401$/.test(message)) return 'Key 无效或已过期（HTTP 401）';
  if (/^HTTP 403$/.test(message)) return 'Key 无权限或产品不匹配（HTTP 403）';
  if (/^HTTP 429$/.test(message)) return '请求过于频繁（HTTP 429）';
  if (/^HTTP 5\d\d$/.test(message)) return `服务暂不可用（${message}）`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(message)) {
    return '网络不可达';
  }
  if (/数据格式异常|百分比超出|套餐剩余超过|查询失败|响应中无|无法确定|余额币种未知/.test(message)) {
    return message.slice(0, 120);
  }
  if (/模型来源地址/.test(message)) return message.slice(0, 160);
  return '查询失败，请稍后刷新';
}

export function createMonitor({ provider, adapter, credentials }) {
  const subscribers = new Set();
  const state = {
    provider,
    adapter,
    quotaData: null,
    quotaFetchedAt: 0,
    errorText: '',
    lastRefreshError: '',
    loading: false,
    fetchSeq: 0,
    lastAttemptAt: 0,
  };
  let controller;
  let inflight;
  let timer;
  let lastContext;

  function content() {
    return quotaContent(state, adapter);
  }

  function publish() {
    const value = content();
    for (const callback of subscribers) {
      try {
        callback(value);
      } catch {
        // One disconnected renderer must not stop other subscribers.
      }
    }
  }

  async function refresh(context, options = {}) {
    if (!context) return;
    lastContext = context;
    if (inflight) return inflight;
    const now = Date.now();
    if (options.force !== true) {
      if (state.quotaData && now - state.quotaFetchedAt < 5_000) return;
      if (state.errorText && now - state.lastAttemptAt < 5_000) return;
    }
    const sequence = ++state.fetchSeq;
    controller = new AbortController();
    const signal = controller.signal;
    state.loading = true;
    state.lastAttemptAt = now;
    if (options.initial !== false) publish();
    inflight = (async () => {
      try {
        const credential = await credentials.read(provider, { signal });
        if (sequence !== state.fetchSeq || signal.aborted) return;
        if (!credential?.apiKey) {
          state.quotaData = null;
          state.quotaFetchedAt = 0;
          state.errorText = `${adapter.display} 尚未配置 Studio API Key`;
          return;
        }
        if (!adapterMatchesBaseUrl(adapter, credential.baseUrl)) {
          throw new Error(
            `模型来源地址 ${credential.baseUrl} 与 ${adapter.display} 的官方额度账户不匹配`,
          );
        }
        const bars = await adapter.fetch(credential.apiKey, signal);
        if (sequence !== state.fetchSeq || signal.aborted) return;
        if (!Array.isArray(bars) || bars.length === 0) {
          throw new Error('响应中无额度数据');
        }
        state.quotaData = {
          provider: adapter.display,
          bars,
        };
        state.quotaFetchedAt = Date.now();
        state.errorText = '';
        state.lastRefreshError = '';
      } catch (error) {
        if (sequence !== state.fetchSeq || signal.aborted) return;
        const message = describeFetchError(error);
        const transient = /请求超时|网络不可达|服务暂不可用|请求过于频繁/.test(message);
        const keep = transient
          && state.quotaData
          && state.quotaFetchedAt > 0
          && Date.now() - state.quotaFetchedAt <= STALE_KEEP_MS;
        if (keep) {
          state.lastRefreshError = message;
        } else {
          state.quotaData = null;
          state.quotaFetchedAt = 0;
          state.errorText = `${adapter.display} ${message}`;
          state.lastRefreshError = '';
        }
      } finally {
        if (sequence === state.fetchSeq) {
          controller = undefined;
          state.loading = false;
          publish();
          if (subscribers.size === 0) lastContext = undefined;
        }
        inflight = undefined;
      }
    })();
    return inflight;
  }

  function subscribe(context, callback) {
    subscribers.add(callback);
    lastContext = context;
    callback(content());
    if (!timer) {
      timer = setInterval(() => {
        if (lastContext) void refresh(lastContext, { initial: false });
      }, MONITOR_REFRESH_MS);
      timer.unref?.();
    }
    return () => {
      subscribers.delete(callback);
      if (subscribers.size === 0 && timer) {
        clearInterval(timer);
        timer = undefined;
        controller?.abort();
        controller = undefined;
        lastContext = undefined;
      }
    };
  }

  function dispose() {
    subscribers.clear();
    if (timer) clearInterval(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
    inflight = undefined;
    lastContext = undefined;
    state.fetchSeq += 1;
  }

  return {
    get lastContext() {
      return lastContext;
    },
    state,
    content,
    refresh,
    subscribe,
    dispose,
  };
}
