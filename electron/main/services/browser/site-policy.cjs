/**
 * Site × action_class policy for the in-app browser (second gate after tools).
 */
const { getStudioDatabase } = require('../../core/studio-db.cjs');

const SETTING_KEY = 'studio.browser.sitePolicies';
const ACTION_CLASSES = new Set([
  'navigate', 'read', 'act', 'wait', 'download', 'clipboard', 'dialog', 'storage', 'evaluate', 'cdp',
]);
const DECISIONS = new Set(['allow', 'ask', 'deny']);

function normalizePattern(value) {
  return String(value || '').trim().toLowerCase().slice(0, 253);
}

function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '[::1]'
    || host === '::1'
    || host.endsWith('.localhost')
    || host.endsWith('.local');
}

function originOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (!/^https?:$/i.test(parsed.protocol) && parsed.protocol !== 'file:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function hostnameOf(url) {
  try {
    return new URL(String(url || '')).hostname || '';
  } catch {
    return '';
  }
}

function patternMatches(pattern, origin, hostname) {
  const p = normalizePattern(pattern);
  if (!p) return false;
  if (p === '*') return true;
  if (p === 'localhost' || p === 'local') return isLocalHost(hostname);
  const o = String(origin || '').toLowerCase();
  const h = String(hostname || '').toLowerCase();
  if (p === o || p === h) return true;
  if (p.startsWith('*.') && (h === p.slice(2) || h.endsWith(p.slice(1)))) return true;
  return false;
}

function normalizePolicies(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const row of input) {
    if (!row || typeof row !== 'object') continue;
    const originPattern = normalizePattern(row.originPattern || row.pattern);
    const actionClass = String(row.actionClass || row.action || '').trim().toLowerCase();
    const decision = String(row.decision || '').trim().toLowerCase();
    if (!originPattern || !ACTION_CLASSES.has(actionClass) || !DECISIONS.has(decision)) continue;
    out.push({
      id: String(row.id || `${originPattern}:${actionClass}:${decision}`).slice(0, 120),
      originPattern,
      actionClass,
      decision,
      note: typeof row.note === 'string' ? row.note.slice(0, 200) : '',
      updatedAt: Number(row.updatedAt) || Date.now(),
    });
    if (out.length >= 200) break;
  }
  return out;
}

function readSitePolicies(db = getStudioDatabase()) {
  return db.getSettingWithRecovery(SETTING_KEY, [], normalizePolicies);
}

function saveSitePolicies(input, db = getStudioDatabase()) {
  const next = normalizePolicies(input);
  db.setSetting(SETTING_KEY, next);
  return next;
}

function upsertSitePolicy(input, db = getStudioDatabase()) {
  const originPattern = normalizePattern(input.originPattern || input.pattern);
  const actionClass = String(input.actionClass || '').trim().toLowerCase();
  const decision = String(input.decision || '').trim().toLowerCase();
  if (!originPattern) throw new Error('需要 originPattern');
  if (!ACTION_CLASSES.has(actionClass)) throw new Error(`无效 actionClass：${actionClass}`);
  if (!DECISIONS.has(decision)) throw new Error(`无效 decision：${decision}`);
  const current = readSitePolicies(db).filter(
    (row) => !(row.originPattern === originPattern && row.actionClass === actionClass),
  );
  current.unshift({
    id: `${originPattern}:${actionClass}`,
    originPattern,
    actionClass,
    decision,
    note: typeof input.note === 'string' ? input.note.slice(0, 200) : '',
    updatedAt: Date.now(),
  });
  return saveSitePolicies(current, db);
}

function removeSitePolicy(idOrPattern, actionClass, db = getStudioDatabase()) {
  const key = normalizePattern(idOrPattern);
  const action = actionClass ? String(actionClass).toLowerCase() : '';
  const next = readSitePolicies(db).filter((row) => {
    if (row.id === String(idOrPattern || '')) return false;
    if (action && row.originPattern === key && row.actionClass === action) return false;
    if (!action && (row.originPattern === key || row.id === key)) return false;
    return true;
  });
  return saveSitePolicies(next, db);
}

function resolveSiteAction(url, actionClass, db = getStudioDatabase()) {
  const action = String(actionClass || '').toLowerCase();
  if (!ACTION_CLASSES.has(action)) {
    return { decision: 'ask', source: 'default', actionClass: action, origin: originOf(url) };
  }
  const origin = originOf(url);
  const hostname = hostnameOf(url);
  const policies = readSitePolicies(db);
  for (const row of policies) {
    if (row.actionClass !== action) continue;
    if (!patternMatches(row.originPattern, origin, hostname)) continue;
    return {
      decision: row.decision,
      source: 'policy',
      actionClass: action,
      origin,
      policy: row,
    };
  }
  if (action === 'evaluate' || action === 'cdp') {
    return { decision: 'deny', source: 'default', actionClass: action, origin };
  }
  if (isLocalHost(hostname) && (action === 'read' || action === 'act' || action === 'wait' || action === 'navigate')) {
    return { decision: 'allow', source: 'localhost', actionClass: action, origin };
  }
  if (action === 'read' || action === 'wait') {
    return { decision: 'allow', source: 'default', actionClass: action, origin };
  }
  if (action === 'navigate' || action === 'act' || action === 'dialog' || action === 'download') {
    return { decision: 'ask', source: 'default', actionClass: action, origin };
  }
  return { decision: 'deny', source: 'default', actionClass: action, origin };
}

function assertSiteActionAllowed(url, actionClass, options = {}) {
  const resolved = resolveSiteAction(url, actionClass);
  if (resolved.decision === 'deny') {
    const error = new Error(`站点策略拒绝 ${actionClass}：${resolved.origin || url || 'unknown'}`);
    error.code = 'site_policy_deny';
    error.details = resolved;
    throw error;
  }
  if (resolved.decision === 'ask' && options.requireAllow) {
    const error = new Error(`站点策略要求确认 ${actionClass}：${resolved.origin || url || 'unknown'}（可在浏览器菜单中允许该站点）`);
    error.code = 'site_policy_ask';
    error.details = resolved;
    throw error;
  }
  return resolved;
}

module.exports = {
  ACTION_CLASSES,
  assertSiteActionAllowed,
  isLocalHost,
  originOf,
  readSitePolicies,
  removeSitePolicy,
  resolveSiteAction,
  saveSitePolicies,
  upsertSitePolicy,
};
