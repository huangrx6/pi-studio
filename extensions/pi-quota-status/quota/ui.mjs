import { STALE_KEEP_MS } from './types.mjs';

const SHORT_PROVIDERS = new Map([
  ['OpenCode Go', 'OC'],
  ['GLM Coding Plan', 'GLM'],
  ['MiniMax Token Plan', 'MM'],
  ['Kimi Code', 'KC'],
  ['DeepSeek API', 'DS'],
  ['Kimi API', 'KIMI'],
  ['SiliconFlow', 'SF'],
  ['OpenRouter 当前 Key', 'OR'],
]);

const SHORT_LABELS = new Map([
  ['5 小时', '5H'],
  ['本周', 'W'],
  ['本月', 'M'],
  ['套餐', 'PLAN'],
  ['余额', 'BAL'],
  ['可用余额', 'BAL'],
  ['Key 剩余', 'KEY'],
  ['Key 上限', 'KEY'],
  ['状态', 'STATUS'],
]);

function shortProvider(adapter) {
  return SHORT_PROVIDERS.get(adapter?.display)
    || String(adapter?.display || '—').replace(/\s+/g, '').slice(0, 6).toUpperCase();
}

function shortLabel(label) {
  return SHORT_LABELS.get(label)
    || String(label || '').replace(/\s+/g, '').slice(0, 5).toUpperCase();
}

function duration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} 分钟后重置`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} 小时${rest ? ` ${rest} 分钟` : ''}后重置`;
}

function metricId(bar, index) {
  return `quota-${index}-${bar.kind}`;
}

export function quotaContent(state, adapter) {
  if (!adapter) {
    return [{
      kind: 'notice',
      tone: 'info',
      title: '当前模型来源没有额度适配器',
      text: '额度只按明确的 provider 和固定接口查询，不会根据模型名称猜测账户。',
    }];
  }
  const content = [];
  if (state.errorText) {
    content.push({
      kind: 'notice',
      tone: 'error',
      title: `${adapter.display} 查询失败`,
      text: state.errorText,
    });
  }
  if (state.quotaData?.bars?.length) {
    const elapsed = Math.max(0, Date.now() - state.quotaFetchedAt);
    const metrics = state.quotaData.bars.map((bar, index) => {
      if (bar.kind === 'percentage') {
        return {
          id: metricId(bar, index),
          label: bar.label,
          value: bar.percent === null ? '—' : Math.round(bar.percent * 10) / 10,
          unit: bar.percent === null ? undefined : '%',
          detail: bar.resetsInMs === undefined
            ? '已用'
            : duration(bar.resetsInMs - elapsed),
          tone: (bar.percent || 0) >= 90 ? 'warning' : 'neutral',
        };
      }
      if (bar.kind === 'balance') {
        return {
          id: metricId(bar, index),
          label: bar.label,
          value: bar.amount === null ? '—' : bar.amount.toFixed(2),
          unit: bar.currency,
          detail: adapter.category,
          tone: 'neutral',
        };
      }
      return {
        id: metricId(bar, index),
        label: bar.label,
        value: bar.text,
        detail: adapter.category,
        tone: 'neutral',
      };
    });
    content.push({
      kind: 'metricGrid',
      columns: Math.min(4, Math.max(1, metrics.length)),
      metrics,
    });
    if (elapsed > STALE_KEEP_MS) {
      content.push({
        kind: 'notice',
        tone: 'warning',
        text: '当前显示上次成功值，可能已经过期。',
      });
    }
    if (state.lastRefreshError) {
      content.push({
        kind: 'notice',
        tone: 'warning',
        title: '刷新失败，暂时显示上次成功值',
        text: state.lastRefreshError,
      });
    }
  } else if (state.loading) {
    content.push({
      kind: 'statusList',
      items: [{
        id: 'loading',
        label: `正在查询 ${adapter.display}`,
        detail: '凭证只在本次查询中读取',
        status: 'active',
      }],
    });
  } else {
    content.push({
      kind: 'emptyState',
      title: '尚无额度数据',
      text: '点击刷新，或等待自动更新。',
    });
  }
  return content;
}

export function quotaSummary(state, adapter) {
  if (!adapter) {
    return [{
      kind: 'text',
      text: 'QUOTA · —',
    }];
  }
  const provider = shortProvider(adapter);
  if (state.errorText) {
    return [{
      kind: 'text',
      text: `${provider} · ERR`,
    }];
  }
  if (!state.quotaData?.bars?.length) {
    return [{
      kind: 'text',
      text: `${provider} · ${state.loading ? 'SYNC' : '—'}`,
    }];
  }
  const values = state.quotaData.bars.slice(0, 2).map((bar) => {
    if (bar.kind === 'percentage') {
      return `${shortLabel(bar.label)} ${bar.percent === null ? '—' : `${Math.round(bar.percent * 10) / 10}%`}`;
    }
    if (bar.kind === 'balance') {
      return `${shortLabel(bar.label)} ${bar.amount === null ? '—' : `${bar.currency}${bar.amount.toFixed(2)}`}`;
    }
    return `${shortLabel(bar.label)} ${bar.text}`;
  });
  return [{
    kind: 'text',
    text: `${values.join(' · ')} · ${provider}`,
  }];
}
