const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function mockElectron(t, electron) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => {
    Module._load = originalLoad;
  });
}

test('credential storage encrypts at the SQLite boundary and reads legacy values', (t) => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      return Buffer.from(`protected:${value}`, 'utf8');
    },
    decryptString(value) {
      const decoded = Buffer.from(value).toString('utf8');
      assert.match(decoded, /^protected:/);
      return decoded.slice('protected:'.length);
    },
  };
  mockElectron(t, { safeStorage });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-secure-value-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { StudioDatabase } = require('../../electron/core/studio-db.cjs');
  const database = new StudioDatabase(path.join(directory, 'studio.sqlite'));
  t.after(() => database.db.close());

  database.upsertProvider({
    id: 'provider-secure',
    name: 'Secure provider',
    api: 'openai-completions',
  });
  const credential = { type: 'api_key', key: 'secret-v1' };
  database.writeCredential('provider-secure', credential);

  assert.deepEqual(database.readCredential('provider-secure'), credential);
  const raw = JSON.parse(database.db.prepare(`
    SELECT value FROM credentials WHERE provider_id = ?
  `).get('provider-secure').value);
  assert.equal(raw.format, 'safeStorage-v1');
  assert.equal(typeof raw.data, 'string');
  assert.doesNotMatch(raw.data, /secret-v1|"api_key"/);

  database.deleteCredential('provider-secure');
  database.db.prepare(`
    INSERT INTO credentials(provider_id, value, updated_at) VALUES (?, ?, ?)
  `).run(
    'provider-secure',
    JSON.stringify({ type: 'api_key', key: 'legacy-secret' }),
    Date.now(),
  );
  assert.deepEqual(database.readCredential('provider-secure'), {
    type: 'api_key',
    key: 'legacy-secret',
  });
});

test('credential storage fails closed when Electron safeStorage is unavailable', (t) => {
  mockElectron(t, {});
  const { encryptValue, SECURE_STORAGE_UNAVAILABLE } = require('../../electron/core/secure-value.cjs');
  const value = { type: 'api_key', key: 'headless-secret' };
  assert.throws(
    () => encryptValue(value),
    (error) => error.code === SECURE_STORAGE_UNAVAILABLE && /未写入/.test(error.message),
  );
});
