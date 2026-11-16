const { normalizeSecureHttpUrl } = require('./external-url.cjs');

const MAX_QUOTA_FIELDS = 24;
const FORMATS = new Set(['number', 'percent', 'fraction', 'enum', 'time']);
const KEY = /^[\p{L}\p{N}_$-]+/u;
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 });
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

function shortText(value, max, label) {
  const text = (value ?? '');
  if (typeof text !== 'string' || text.length > max || /[\x00-\x1F\x7F]/.test(text)) {
    throw new Error(`${label}格式无效，最多 ${max} 个字符。`);
  }
  return text.trim();
}

// A path addresses own JSON properties, numeric indices or a stable array key.
// For example, windows[period=week].remaining survives reordered responses.
function pathSteps(path) {
  const invalid = () => new Error('字段路径无效，可使用 data.balance、limits[0].used 或 limits[period=week].used。');
  const steps = [];
  let rest = path;
  while (rest) {
    if (steps.length >= 24) throw invalid();
    if (rest.startsWith('[')) {
      const match = /^\[([^\[\]\r\n]+)\]/u.exec(rest);
      if (!match) throw invalid();
      if (/^\d{1,8}$/.test(match[1])) steps.push(Number(match[1]));
      else {
        const parts = match[1].split('&');
        if (parts.length > 4) throw invalid();
        steps.push(parts.map(part => {
          const pair = /^([\p{L}\p{N}_$-]+)=([^=]{1,64})$/u.exec(part.trim());
          if (!pair || BLOCKED.has(pair[1]) || !pair[2].trim()) throw invalid();
          return { key: pair[1], equals: pair[2].trim() };
        }));
      }
      rest = rest.slice(match[0].length);
    } else {
      if (steps.length) {
        if (rest[0] !== '.') throw invalid();
        rest = rest.slice(1);
      }
      const match = KEY.exec(rest);
      if (!match || BLOCKED.has(match[0])) throw invalid();
      steps.push(match[0]);
      rest = rest.slice(match[0].length);
    }
  }
  if (!steps.length) throw invalid();
  return steps;
}

function readPath(root, path) {
  let value = root;
  for (const step of pathSteps(path)) {
    if (value === null || typeof value !== 'object') return undefined;
    if (Array.isArray(step)) {
      if (!Array.isArray(value)) return undefined;
      value = value.find(item => item && typeof item === 'object' && step.every(({ key, equals }) =>
        Object.hasOwn(item, key) && ['string', 'number', 'boolean'].includes(typeof item[key]) && String(item[key]) === equals));
    } else {
      if ((typeof step === 'number') !== Array.isArray(value) || !Object.hasOwn(value, step)) return undefined;
      value = value[step];
    }
  }
  return value;
}

function translations(text) {
  if (typeof text !== 'string' || text.length > 2048) throw new Error('值翻译最多 2048 个字符。');
  const result = new Map();
  for (const line of text.split(/\r?\n/).map(row => row.trim()).filter(Boolean)) {
    const split = line.indexOf('=');
    if (split < 1) throw new Error('每行值翻译请填写「接口值=中文含义」。');
    const key = shortText(line.slice(0, split), 100, '接口值');
    const label = shortText(line.slice(split + 1), 80, '中文含义');
    if (!key || !label || result.has(key)) throw new Error('值翻译需要唯一的接口值和对应的中文含义。');
    result.set(key, label);
  }
  return result;
}

function normalizeQuotaFields(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_QUOTA_FIELDS) {
    throw new Error(`请配置 1 至 ${MAX_QUOTA_FIELDS} 个额度字段。`);
  }
  const fields = input.map((row, index) => {
    const label = shortText(row?.label, 48, '显示名称');
    const path = shortText(row?.path, 256, '字段路径');
    if (!label || !path) throw new Error(`请填写第 ${index + 1} 项的显示名称和字段路径。`);
    pathSteps(path);
    if (!FORMATS.has(row.format)) throw new Error('请选择有效的额度显示格式。');
    const aliases = row.format === 'enum' ? row.translations : '';
    if (row.format === 'enum' && !translations(aliases).size) throw new Error('状态字段至少需要一条值翻译。');
    const summary = row.summary === undefined ? index < 2 : row.summary;
    if (typeof summary !== 'boolean') throw new Error('会话摘要选项无效。');
    return { label, path, format: row.format, unit: row.format === 'number' ? shortText(row.unit, 16, '单位') : '', translations: aliases, summary };
  });
  if (fields.filter(field => field.summary).length > 2) throw new Error('会话摘要最多显示两个额度字段。');
  return fields;
}

function quotaConnection(input) {
  const endpoint = normalizeSecureHttpUrl(input.endpoint, { label: '额度接口' });
  // Dimension filters such as token_type and groupByKey can be public. Match
  // credential parameter names rather than every occurrence of "token"/"key".
  const credentialParam = /(?:^|[-_.])(?:key|api[-_]?key|(?:access|refresh|auth|session|api)[-_]?token|token|(?:client[-_]?)?secret|secret[-_]?key|password|signature|authorization|credential|sig)$/i;
  if ([...new URL(endpoint).searchParams.keys()].some(key => credentialParam.test(key))) {
    throw new Error('额度接口地址不能包含凭据，请使用认证选项。');
  }
  if (!['none', 'bearer', 'x-api-key'].includes(input.auth)) throw new Error('请选择有效的额度接口认证方式。');
  return { endpoint, auth: input.auth };
}

function normalizeProviderQuota(input) {
  if (input === null) return null;
  if (!input || typeof input.enabled !== 'boolean') throw new Error('额度监控配置无效。');
  return { enabled: input.enabled, ...quotaConnection(input), fields: normalizeQuotaFields(input.fields) };
}

function numeric(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function projectQuota(fields, data, credential = '') {
  // Only configured, formatted scalar metrics cross IPC, never arbitrary text
  // returned by an endpoint (including echoed headers or an error response).
  return fields.map(field => {
    const raw = readPath(data, field.path);
    const metric = { label: field.label, value: null, summary: field.summary };
    if (raw === undefined) return { ...metric, issue: '未返回此字段' };
    if (credential && (typeof raw === 'number' || typeof raw === 'string') && String(raw).includes(credential)) return { ...metric, issue: '无法显示此值' };
    if (field.format === 'enum') {
      const value = (raw === null || typeof raw !== 'object') && translations(field.translations).get(String(raw));
      return value ? { ...metric, value } : { ...metric, issue: '缺少对应的值翻译' };
    }
    const n = numeric(raw);
    if (field.format === 'time') {
      const millis = n !== null ? (Math.abs(n) < 1e11 ? n * 1000 : n)
        : typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(raw) ? Date.parse(raw) : NaN;
      const time = new Date(millis);
      return Number.isFinite(time.getTime()) ? { ...metric, value: dateFormat.format(time) } : { ...metric, issue: '时间格式不匹配' };
    }
    if (n === null) return { ...metric, issue: '需要数值' };
    if (field.format === 'number') return { ...metric, value: [numberFormat.format(n), field.unit].filter(Boolean).join(' ') };
    const percent = field.format === 'fraction' ? n * 100 : n;
    if (percent < 0 || percent > 100) return { ...metric, issue: '超出百分比范围' };
    return { ...metric, value: `${numberFormat.format(percent)}%`, percent };
  });
}

function previewQuota({ fields, sample } = {}) {
  if (typeof sample !== 'string' || Buffer.byteLength(sample) > 65536) throw new Error('返回样例最多 64 KB。');
  let data;
  try { data = JSON.parse(sample); } catch { throw new Error('返回样例需要是有效的 JSON。'); }
  return projectQuota(normalizeQuotaFields(fields), data);
}

function quotaFieldPaths(data, credential = '') {
  const paths = [];
  function visit(value, path, depth) {
    if (depth > 10 || path.length > 256 || paths.length >= 120) return;
    if (value === null || typeof value !== 'object') {
      if (path) paths.push({ path, format: numeric(value) !== null ? 'number' : 'enum' });
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 12).forEach((item, i) => visit(item, `${path}[${i}]`, depth + 1));
    } else {
      for (const [key, item] of Object.entries(value)) {
        if (paths.length >= 120) break;
        if (!/^[\p{L}\p{N}_$-]{1,80}$/u.test(key) || BLOCKED.has(key) || (credential && key.includes(credential))
          || /password|secret|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie/i.test(key)) continue;
        visit(item, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  }
  visit(data, '', 0);
  return paths;
}

module.exports = { normalizeProviderQuota, previewQuota, projectQuota, quotaConnection, quotaFieldPaths };
