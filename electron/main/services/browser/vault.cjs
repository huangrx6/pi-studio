/**
 * Lightweight browser vault: site passwords (safeStorage) and contact profiles.
 * Passwords never leave main as plaintext except for explicit reveal/copy IPC.
 */
const { getStudioDatabase } = require('../../core/studio-db.cjs');
const {
  decryptValue,
  decryptValueAsync,
  encryptValue,
  encryptValueAsync,
  secureStorageAvailable,
  secureStorageAsyncAvailable,
} = require('../../core/secure-value.cjs');

const PASSWORDS_KEY = 'studio.browser.passwords';
const CONTACTS_KEY = 'studio.browser.contacts';

function nextId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
    return url.origin;
  } catch {
    return raw.slice(0, 200);
  }
}

function projectPassword(row, { includeSecret = false } = {}) {
  return {
    id: row.id,
    origin: row.origin,
    username: row.username,
    note: row.note || '',
    updatedAt: row.updatedAt || 0,
    ...(includeSecret ? { password: row.password || '' } : {}),
  };
}

function projectContact(row) {
  return {
    id: row.id,
    name: row.name || '',
    phone: row.phone || '',
    email: row.email || '',
    address: row.address || '',
    updatedAt: row.updatedAt || 0,
  };
}

async function readPasswords(db = getStudioDatabase()) {
  const stored = db.getSetting(PASSWORDS_KEY);
  if (!stored) return [];
  let payload = stored;
  try {
    payload = secureStorageAsyncAvailable()
      ? await decryptValueAsync(stored)
      : decryptValue(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      id: String(row.id || nextId('pwd')),
      origin: normalizeOrigin(row.origin),
      username: String(row.username || '').slice(0, 200),
      password: String(row.password || ''),
      note: String(row.note || '').slice(0, 200),
      updatedAt: Number(row.updatedAt) || Date.now(),
    }))
    .filter((row) => row.origin)
    .slice(0, 200);
}

async function writePasswords(rows, db = getStudioDatabase()) {
  const normalized = (Array.isArray(rows) ? rows : []).slice(0, 200);
  const envelope = secureStorageAsyncAvailable()
    ? await encryptValueAsync(normalized)
    : encryptValue(normalized);
  db.setSetting(PASSWORDS_KEY, envelope);
  return normalized;
}

function readContacts(db = getStudioDatabase()) {
  return db.getSettingWithRecovery(CONTACTS_KEY, [], (value) => {
    if (!Array.isArray(value)) return [];
    return value
      .filter((row) => row && typeof row === 'object')
      .map((row) => projectContact({
        id: String(row.id || nextId('ct')),
        name: String(row.name || '').slice(0, 120),
        phone: String(row.phone || '').slice(0, 60),
        email: String(row.email || '').slice(0, 200),
        address: String(row.address || '').slice(0, 400),
        updatedAt: Number(row.updatedAt) || Date.now(),
      }))
      .slice(0, 100);
  });
}

function writeContacts(rows, db = getStudioDatabase()) {
  const next = (Array.isArray(rows) ? rows : []).map(projectContact).slice(0, 100);
  db.setSetting(CONTACTS_KEY, next);
  return next;
}

async function listBrowserPasswords() {
  const rows = await readPasswords();
  return {
    ok: true,
    available: secureStorageAvailable() || secureStorageAsyncAvailable(),
    passwords: rows.map((row) => projectPassword(row)),
  };
}

async function upsertBrowserPassword(input = {}) {
  const origin = normalizeOrigin(input.origin);
  const username = String(input.username || '').trim().slice(0, 200);
  const password = String(input.password || '');
  if (!origin) throw new Error('需要网站地址');
  if (!username) throw new Error('需要用户名');
  if (!password && !input.id) throw new Error('需要密码');
  const rows = await readPasswords();
  const id = input.id ? String(input.id) : nextId('pwd');
  const existing = rows.findIndex((row) => row.id === id);
  const nextRow = {
    id,
    origin,
    username,
    password: password || (existing >= 0 ? rows[existing].password : ''),
    note: String(input.note || '').slice(0, 200),
    updatedAt: Date.now(),
  };
  if (!nextRow.password) throw new Error('需要密码');
  if (existing >= 0) rows[existing] = nextRow;
  else rows.unshift(nextRow);
  await writePasswords(rows);
  return { ok: true, password: projectPassword(nextRow), passwords: rows.map((row) => projectPassword(row)) };
}

async function removeBrowserPassword(id) {
  const rows = await readPasswords();
  const next = rows.filter((row) => row.id !== String(id || ''));
  await writePasswords(next);
  return { ok: true, passwords: next.map((row) => projectPassword(row)) };
}

async function revealBrowserPassword(id) {
  const rows = await readPasswords();
  const row = rows.find((item) => item.id === String(id || ''));
  if (!row) throw new Error('找不到该密码');
  return { ok: true, password: projectPassword(row, { includeSecret: true }) };
}

function listBrowserContacts() {
  return { ok: true, contacts: readContacts() };
}

function upsertBrowserContact(input = {}) {
  const name = String(input.name || '').trim().slice(0, 120);
  if (!name) throw new Error('需要联系人姓名');
  const rows = readContacts();
  const id = input.id ? String(input.id) : nextId('ct');
  const nextRow = projectContact({
    id,
    name,
    phone: String(input.phone || '').trim(),
    email: String(input.email || '').trim(),
    address: String(input.address || '').trim(),
    updatedAt: Date.now(),
  });
  const index = rows.findIndex((row) => row.id === id);
  if (index >= 0) rows[index] = nextRow;
  else rows.unshift(nextRow);
  return { ok: true, contact: nextRow, contacts: writeContacts(rows) };
}

function removeBrowserContact(id) {
  const rows = readContacts().filter((row) => row.id !== String(id || ''));
  return { ok: true, contacts: writeContacts(rows) };
}

module.exports = {
  listBrowserContacts,
  listBrowserPasswords,
  removeBrowserContact,
  removeBrowserPassword,
  revealBrowserPassword,
  upsertBrowserContact,
  upsertBrowserPassword,
};
