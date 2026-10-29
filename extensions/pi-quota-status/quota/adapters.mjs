import {
  array,
  money,
  number,
  object,
  percent,
  percentBarFromLimitRemaining,
  resetIn,
} from './parse.mjs';

export const ENDPOINTS = Object.freeze({
  opencode: 'https://opencode.ai/zen/go/v1/usage',
  zhipu: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
  minimax: 'https://www.minimaxi.com/v1/token_plan/remains',
  deepseek: 'https://api.deepseek.com/user/balance',
  kimi: 'https://api.kimi.com/coding/v1/usages',
  moonshot: 'https://api.moonshot.cn/v1/users/me/balance',
  siliconflow: 'https://api.siliconflow.cn/v1/user/info',
  openrouter: 'https://openrouter.ai/api/v1/key',
});

async function fetchJsonBearer(url, apiKey, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    12_000,
  );
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return object(await response.json());
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export const ADAPTERS = Object.freeze({
  opencode: {
    display: 'OpenCode Go',
    category: '套餐用量',
    providerNames: ['opencode-go'],
    endpointHosts: ['opencode.ai'],
    endpoint: ENDPOINTS.opencode,
    note: 'Go 套餐已用比例；Zen 按量计费不是同一个账户。',
    async fetch(key, signal) {
      const json = await fetchJsonBearer(ENDPOINTS.opencode, key, signal);
      const usage = object(json.usage, '套餐用量');
      const now = Date.now();
      return [
        ['rolling', '5 小时'],
        ['weekly', '本周'],
        ['monthly', '本月'],
      ].map(([field, label]) => {
        const window = object(usage[field], field);
        return {
          kind: 'percentage',
          label,
          percent: percent(window.percent),
          resetsInMs: resetIn(window.resetsAt, now),
        };
      });
    },
  },
  zhipu: {
    display: 'GLM Coding Plan',
    category: '套餐用量',
    providerNames: ['zai-coding-cn', 'zhipu', 'zhipuai', 'bigmodel', 'bigmodel-cn'],
    endpointHosts: ['open.bigmodel.cn'],
    endpoint: ENDPOINTS.zhipu,
    note: '仅国内 Coding Plan；国际站不是同一个额度账户。',
    async fetch(key, signal) {
      const json = await fetchJsonBearer(ENDPOINTS.zhipu, key, signal);
      if (
        json.success === false
        || (json.code !== undefined && ![0, 200, '0', '200'].includes(json.code))
      ) throw new Error('套餐查询失败');
      const limits = array(object(json.data).limits, '套餐窗口').map(object);
      const bars = [];
      for (const [unit, label] of [[3, '5 小时'], [6, '本周']]) {
        const window = limits.find((item) => (
          item.type === 'TOKENS_LIMIT' && item.unit === unit
        ));
        if (window) {
          bars.push({
            kind: 'percentage',
            label,
            percent: percent(window.percentage),
            resetsInMs: resetIn(window.nextResetTime),
          });
        }
      }
      if (bars.length === 0) throw new Error('响应中无已识别的套餐窗口');
      return bars;
    },
  },
  minimax: {
    display: 'MiniMax Token Plan',
    category: '套餐用量',
    providerNames: ['minimax', 'cc-switch-mini-max', 'minimax-cn'],
    endpointHosts: ['api.minimaxi.com', 'www.minimaxi.com'],
    endpoint: ENDPOINTS.minimax,
    note: '需要国内 Token Plan 专用 Key。',
    async fetch(key, signal) {
      const json = await fetchJsonBearer(ENDPOINTS.minimax, key, signal);
      if (object(json.base_resp).status_code !== 0) {
        throw new Error('Token Plan 查询失败，请确认专用 Key');
      }
      const buckets = array(json.model_remains, '套餐').map(object);
      const bucket = buckets.find((item) => item.model_name === 'general')
        ?? (buckets.length === 1 ? buckets[0] : undefined);
      if (!bucket) throw new Error('无法确定共享套餐窗口');
      const bars = [];
      for (const [field, label, wall, relative] of [
        ['current_interval_remaining_percent', '5 小时', 'end_time', 'remains_time'],
        ['current_weekly_remaining_percent', '本周', 'weekly_end_time', 'weekly_remains_time'],
      ]) {
        if (!(field in bucket)) continue;
        const remaining = percent(bucket[field]);
        const relativeMs = number(bucket[relative], '重置时间');
        bars.push({
          kind: 'percentage',
          label,
          percent: remaining === null ? null : 100 - remaining,
          resetsInMs: resetIn(bucket[wall])
            ?? (relativeMs !== null && relativeMs >= 0 ? relativeMs : undefined),
        });
      }
      if (bars.length === 0) throw new Error('响应中无用量数据');
      return bars;
    },
  },
  kimi: {
    display: 'Kimi Code',
    category: '套餐用量',
    providerNames: ['kimi', 'kimi-code', 'kimi-coding'],
    endpointHosts: ['api.kimi.com'],
    endpoint: ENDPOINTS.kimi,
    note: 'Kimi Code 专用 Key；不把总窗口推断成固定的一周。',
    async fetch(key, signal) {
      const json = await fetchJsonBearer(ENDPOINTS.kimi, key, signal);
      const bars = [];
      for (const item of json.limits === undefined ? [] : array(json.limits, '套餐窗口')) {
        const limit = object(item);
        const window = object(limit.window);
        if (
          window.duration === 300
          && ['TIME_UNIT_MINUTE', 'MINUTE', 'MINUTES'].includes(
            String(window.timeUnit).toUpperCase(),
          )
          && limit.detail
        ) {
          bars.push(percentBarFromLimitRemaining(limit.detail, '5 小时'));
        }
      }
      if (json.usage) bars.push(percentBarFromLimitRemaining(json.usage, '套餐'));
      if (bars.length === 0) throw new Error('响应中无已识别的套餐窗口');
      return bars;
    },
  },
  deepseek: {
    display: 'DeepSeek API',
    category: '账户余额',
    providerNames: ['deepseek', 'deepseek-cn'],
    endpointHosts: ['api.deepseek.com'],
    endpoint: ENDPOINTS.deepseek,
    note: '按接口返回币种逐项显示余额。',
    async fetch(key, signal) {
      const json = await fetchJsonBearer(ENDPOINTS.deepseek, key, signal);
      if (typeof json.is_available !== 'boolean') {
        throw new Error('账户状态数据格式异常');
      }
      const entries = array(json.balance_infos, '余额');
      if (entries.length === 0) throw new Error('响应中无余额数据');
      const bars = entries.map((item) => {
        const entry = object(item);
        if (entry.currency !== 'CNY' && entry.currency !== 'USD') {
          throw new Error('余额币种未知');
        }
        return money('余额', entry.total_balance, entry.currency === 'CNY' ? '¥' : '$');
      });
      if (!json.is_available) {
        bars.push({ kind: 'text', label: '状态', text: '当前不可调用' });
      }
      return bars;
    },
  },
  moonshot: {
    display: 'Kimi API',
    category: '账户余额',
    providerNames: ['moonshot', 'moonshot-cn', 'kimi-api'],
    endpointHosts: ['api.moonshot.cn'],
    endpoint: ENDPOINTS.moonshot,
    note: '国内 API 可用余额；与 Kimi Code 套餐分开。',
    async fetch(key, signal) {
      const json = await fetchJsonBearer(ENDPOINTS.moonshot, key, signal);
      if (json.code !== 0 || json.status !== true) throw new Error('API 余额查询失败');
      return [money('可用余额', object(json.data).available_balance, '¥')];
    },
  },
  siliconflow: {
    display: 'SiliconFlow',
    category: '账户余额',
    providerNames: ['siliconflow', 'siliconflow-cn'],
    endpointHosts: ['api.siliconflow.cn'],
    endpoint: ENDPOINTS.siliconflow,
    note: '国内账户 totalBalance；包含赠送与充值余额。',
    async fetch(key, signal) {
      const json = await fetchJsonBearer(ENDPOINTS.siliconflow, key, signal);
      if (json.code !== 20000 || json.status !== true) throw new Error('账户余额查询失败');
      return [money('余额', object(json.data).totalBalance, '¥')];
    },
  },
  openrouter: {
    display: 'OpenRouter 当前 Key',
    category: '密钥额度',
    providerNames: ['openrouter'],
    endpointHosts: ['openrouter.ai'],
    endpoint: ENDPOINTS.openrouter,
    note: 'Key 的剩余消费上限不代表账户总余额。',
    async fetch(key, signal) {
      const data = object((await fetchJsonBearer(ENDPOINTS.openrouter, key, signal)).data);
      if (data.limit === null && data.limit_remaining === null) {
        return [{ kind: 'text', label: 'Key 上限', text: '未设置' }];
      }
      return [money('Key 剩余', data.limit_remaining, '$')];
    },
  },
});

const PROVIDER_TO_ADAPTER = new Map(
  Object.entries(ADAPTERS).flatMap(([id, adapter]) => (
    adapter.providerNames.map((provider) => [provider, id])
  )),
);

export function adapterForProvider(provider) {
  const id = PROVIDER_TO_ADAPTER.get(provider);
  return id ? ADAPTERS[id] : undefined;
}

export function adapterMatchesBaseUrl(adapter, baseUrl) {
  if (!baseUrl) return true;
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:'
    && !parsed.username
    && !parsed.password
    && adapter.endpointHosts.includes(parsed.hostname);
}

export function supportedProviders() {
  return [...PROVIDER_TO_ADAPTER.keys()].sort();
}
