/**
 * Small encrypted-value envelope backed by Electron safeStorage.
 *
 * Production writes fail closed when the operating system credential store is
 * unavailable. The old `json-v1` tag is accepted only so a versioned migration
 * can re-encrypt data written by development builds; it is never emitted.
 */

const SECURE_STORAGE_UNAVAILABLE = 'SECURE_STORAGE_UNAVAILABLE';
const LEGACY_PLAINTEXT_FORMAT = 'json-v1';
const SAFE_STORAGE_FORMAT = 'safeStorage-v1';

function secureStorageError() {
  const error = new Error('系统安全存储不可用，凭证未写入');
  error.code = SECURE_STORAGE_UNAVAILABLE;
  return error;
}

function safeStorageApi() {
  try {
    const electron = require('electron');
    if (electron?.safeStorage?.isEncryptionAvailable?.()) {
      return electron.safeStorage;
    }
  } catch {
    // Electron is unavailable in plain Node test processes.
  }
  return undefined;
}

function encryptValue(value) {
  const safeStorage = safeStorageApi();
  if (!safeStorage) throw secureStorageError();
  return {
    format: SAFE_STORAGE_FORMAT,
    data: safeStorage.encryptString(JSON.stringify(value)).toString('base64'),
  };
}

function decryptValue(stored) {
  if (stored === undefined || stored === null) return undefined;
  if (typeof stored !== 'object' || Array.isArray(stored)) return stored;
  if (stored.format === LEGACY_PLAINTEXT_FORMAT) return stored.data;
  if (!Object.hasOwn(stored, 'format')) return stored;
  if (stored.format !== SAFE_STORAGE_FORMAT || typeof stored.data !== 'string') return undefined;
  const safeStorage = safeStorageApi();
  if (!safeStorage) throw secureStorageError();
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(stored.data, 'base64')));
  } catch {
    return undefined;
  }
}

function isEncryptedEnvelope(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.format === SAFE_STORAGE_FORMAT,
  );
}

function secureStorageAvailable() {
  return Boolean(safeStorageApi());
}

module.exports = {
  LEGACY_PLAINTEXT_FORMAT,
  SAFE_STORAGE_FORMAT,
  SECURE_STORAGE_UNAVAILABLE,
  decryptValue,
  encryptValue,
  isEncryptedEnvelope,
  secureStorageAvailable,
};
