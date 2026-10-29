const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-registry-settings-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const {
  getExtensionRegistryUrl,
  setExtensionRegistryUrl,
} = require('../../electron/core/app-settings.cjs');
const { closeStudioDatabase } = require('../../electron/core/studio-db.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('extension registry settings reject credentials and remove fragments', () => {
  assert.throws(
    () => setExtensionRegistryUrl('https://user:secret@registry.example/pi.json'),
    /用户名或密码/,
  );
  assert.throws(
    () => setExtensionRegistryUrl('http://registry.example/pi.json'),
    /HTTPS/,
  );
  assert.equal(
    setExtensionRegistryUrl('https://registry.example/pi.json?channel=stable#fragment'),
    'https://registry.example/pi.json?channel=stable',
  );
  assert.equal(
    getExtensionRegistryUrl(),
    'https://registry.example/pi.json?channel=stable',
  );
  assert.equal(
    setExtensionRegistryUrl('http://127.0.0.1:4317/registry.json'),
    'http://127.0.0.1:4317/registry.json',
  );
});
