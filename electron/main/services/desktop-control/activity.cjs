/**
 * Local desktop-observation activity log (metadata only; never stores screenshots or AX values).
 */
const { getStudioDatabase } = require('../../core/studio-db.cjs');

const SETTING_KEY = 'desktopControlActivity';
const MAX_ENTRIES = 100;

function normalizeEntry(input) {
  if (!input || typeof input !== 'object') return null;
  const tool = String(input.tool || '').trim();
  if (!tool) return null;
  const at = Number(input.at) || Date.now();
  const entry = {
    id: String(input.id || `${at}-${Math.random().toString(16).slice(2, 8)}`),
    at,
    tool,
    ok: input.ok !== false,
    code: input.code ? String(input.code) : '',
    appName: input.appName ? String(input.appName) : '',
    bundleId: input.bundleId ? String(input.bundleId) : '',
    windowId: input.windowId != null && input.windowId !== '' ? Number(input.windowId) : null,
    title: input.title ? String(input.title).slice(0, 120) : '',
    detail: input.detail ? String(input.detail).slice(0, 200) : '',
  };
  if (Number.isNaN(entry.windowId)) entry.windowId = null;
  return entry;
}

function listDesktopActivity(limit = 50, db = getStudioDatabase()) {
  const raw = db.getSetting(SETTING_KEY, []);
  const rows = Array.isArray(raw) ? raw : [];
  const max = Math.min(Math.max(Number(limit) || 50, 1), MAX_ENTRIES);
  return rows
    .map((row) => normalizeEntry(row))
    .filter(Boolean)
    .slice(0, max);
}

function appendDesktopActivity(input, db = getStudioDatabase()) {
  const entry = normalizeEntry({ ...input, at: Date.now() });
  if (!entry) return listDesktopActivity(MAX_ENTRIES, db);
  const current = listDesktopActivity(MAX_ENTRIES, db);
  const next = [entry, ...current].slice(0, MAX_ENTRIES);
  db.setSetting(SETTING_KEY, next);
  return next;
}

function clearDesktopActivity(db = getStudioDatabase()) {
  db.setSetting(SETTING_KEY, []);
  return [];
}

module.exports = {
  SETTING_KEY,
  MAX_ENTRIES,
  listDesktopActivity,
  appendDesktopActivity,
  clearDesktopActivity,
  normalizeEntry,
};
