export function object(value, field = '响应') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field}数据格式异常`);
  }
  return value;
}

export function array(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field}数据格式异常`);
  return value;
}

export function number(value, field) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'number'
    && !(typeof value === 'string'
      && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))
  ) {
    throw new Error(`${field}数据格式异常`);
  }
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${field}数据格式异常`);
  return result;
}

export function percent(value) {
  const result = number(value, '百分比');
  if (result !== null && (result < 0 || result > 100)) {
    throw new Error('百分比超出 0–100 范围');
  }
  return result;
}

export function resetIn(value, now = Date.now()) {
  const at = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Date.parse(value)
      : NaN;
  return Number.isFinite(at) && at > 100_000_000_000 ? at - now : undefined;
}

export function percentBarFromLimitRemaining(detail, label, now = Date.now()) {
  const data = object(detail, '套餐');
  const limit = number(data.limit, '套餐上限');
  const remaining = number(data.remaining, '套餐剩余');
  if (limit !== null && limit < 0) throw new Error('套餐上限数据格式异常');
  if (remaining !== null && remaining < 0) throw new Error('套餐剩余数据格式异常');
  if (limit !== null && remaining !== null && remaining > limit) {
    throw new Error('套餐剩余超过上限');
  }
  return {
    kind: 'percentage',
    label,
    percent: limit && remaining !== null ? ((limit - remaining) / limit) * 100 : null,
    resetsInMs: resetIn(data.resetTime, now),
  };
}

export function money(label, value, currency) {
  return {
    kind: 'balance',
    label,
    amount: number(value, '余额'),
    currency,
  };
}
