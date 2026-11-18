/**
 * Named test credentials referenced from model-authored tool arguments.
 *
 * The model only receives `{{secret:NAME}}`. Studio resolves the value in the
 * main process immediately before a tool executes, then restores the
 * placeholder in the result before it is committed or shown in a trace.
 */

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SECRET_REFERENCE = /\{\{secret:([A-Z][A-Z0-9_]{0,63})\}\}/g;

function isValidSecretName(value) {
  return typeof value === 'string' && SECRET_NAME.test(value);
}

function secretReferences(value) {
  const names = new Set();
  const text = JSON.stringify(value) || '';
  for (const match of text.matchAll(SECRET_REFERENCE)) names.add(match[1]);
  return [...names].sort();
}

function mapStrings(value, transform, keys = false) {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, transform, keys));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [keys ? transform(key) : key, mapStrings(entry, transform, keys)]),
  );
}

function expandSecretReferences(value, secrets) {
  const names = secretReferences(value);
  const missing = names.filter((name) => typeof secrets?.[name] !== 'string');
  if (missing.length > 0) {
    throw new Error(`未找到测试凭据：${missing.join('、')}。请先在权限策略中添加对应凭据。`);
  }
  const expanded = mapStrings(value, (text) => text.replace(
    SECRET_REFERENCE,
    (_match, name) => secrets[name],
  ));
  return { value: expanded, names };
}

function createSecretRedactor(secrets) {
  const placeholderByValue = new Map();
  for (const [name, secret] of Object.entries(secrets || {})) {
    if (typeof secret === 'string' && secret.length > 0 && !placeholderByValue.has(secret)) {
      placeholderByValue.set(secret, `{{secret:${name}}}`);
    }
  }
  const values = [...placeholderByValue.keys()].sort((a, b) => b.length - a.length);
  const pattern = values.length
    ? new RegExp(`${SECRET_REFERENCE.source}|${values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}`, 'g')
    : undefined;
  const redactText = (text) => pattern
    ? text.replace(pattern, (match) => placeholderByValue.get(match) || match)
    : text;
  let pending = '';
  return {
    redact: (value) => mapStrings(value, redactText, true),
    // Retain only the suffix that could span the next output chunk. Never
    // commit a partial credential to Durable's progress documents.
    push(chunk, final = false) {
      const text = pending + chunk;
      let end = final ? text.length : Math.max(0, text.length - (values[0]?.length || 1) + 1);
      if (pattern && end < text.length) {
        for (const match of text.matchAll(pattern)) {
          if (match.index < end && match.index + match[0].length > end) {
            end = match.index;
            break;
          }
        }
      }
      pending = text.slice(end);
      return redactText(text.slice(0, end));
    },
  };
}

function redactSecretValues(value, secrets) {
  return createSecretRedactor(secrets).redact(value);
}

module.exports = {
  SECRET_REFERENCE,
  createSecretRedactor,
  expandSecretReferences,
  isValidSecretName,
  redactSecretValues,
  secretReferences,
};
