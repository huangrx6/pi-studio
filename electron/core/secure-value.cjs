/**
 * Small encrypted-value envelope backed by Electron safeStorage.
 *
 * The envelope keeps the storage format explicit so existing credentials can be
 * migrated without guessing whether a JSON object is plaintext or ciphertext.
 * Outside Electron (unit tests and headless checks), the value remains usable as
 * JSON; the packaged app uses the operating system credential store whenever it
 * is available.
 */

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
  if (safeStorage) {
    return {
      format: 'safeStorage-v1',
      data: safeStorage.encryptString(JSON.stringify(value)).toString('base64'),
    };
  }
  return { format: 'json-v1', data: value };
}

function decryptValue(stored) {
  if (stored === undefined || stored === null) return undefined;
  if (typeof stored !== 'object' || Array.isArray(stored)) return stored;
  if (stored.format === 'json-v1') return stored.data;
  if (stored.format !== 'safeStorage-v1' || typeof stored.data !== 'string') return undefined;
  try {
    const safeStorage = safeStorageApi();
    if (!safeStorage) return undefined;
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
    && (value.format === 'safeStorage-v1' || value.format === 'json-v1'),
  );
}

function secureStorageAvailable() {
  return Boolean(safeStorageApi());
}

module.exports = {
  decryptValue,
  encryptValue,
  isEncryptedEnvelope,
  secureStorageAvailable,
};
