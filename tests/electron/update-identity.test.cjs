const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  attachBuildAwareUpdateCheck,
  isSameVersionBuildUpdate,
  readInstalledBuildIdentity,
} = require('../../electron/services/update-identity.cjs');

test('same-version rebuilds are detected from a changed remote build id', () => {
  assert.equal(isSameVersionBuildUpdate(
    { version: '0.0.11', buildId: '1234567890abcdef' },
    '0.0.11',
    'fedcba0987654321',
  ), true);
  assert.equal(isSameVersionBuildUpdate(
    { version: 'v0.0.11', buildId: '1234567890abcdef' },
    '0.0.11',
    '1234567890abcdef',
  ), false);
  assert.equal(isSameVersionBuildUpdate(
    { version: '0.0.12', buildId: '1234567890abcdef' },
    '0.0.11',
    undefined,
  ), false);
});

test('a stamped remote rebuild upgrades legacy installs without a local build id', () => {
  assert.equal(isSameVersionBuildUpdate(
    { version: '0.0.11', buildId: '1234567890abcdef' },
    '0.0.11',
    undefined,
  ), true);
  assert.equal(isSameVersionBuildUpdate(
    { version: '0.0.11' },
    '0.0.11',
    undefined,
  ), false);
});

test('the updater wrapper overrides only equal-semver build changes', async () => {
  const updater = {
    async isUpdateAvailable() {
      return false;
    },
  };
  attachBuildAwareUpdateCheck(updater, {
    currentVersion: '1.2.3',
    getCurrentBuildId: () => 'aaaaaaaaaaaaaaaa',
  });
  assert.equal(await updater.isUpdateAvailable({ version: '1.2.3', buildId: 'bbbbbbbbbbbbbbbb' }), true);
  assert.equal(await updater.isUpdateAvailable({ version: '1.2.3', buildId: 'aaaaaaaaaaaaaaaa' }), false);
  assert.equal(await updater.isUpdateAvailable({ version: '1.2.4', buildId: 'bbbbbbbbbbbbbbbb' }), false);

  const unsupported = {
    async isUpdateAvailable() {
      return false;
    },
    async isUpdateSupported() {
      return false;
    },
  };
  attachBuildAwareUpdateCheck(unsupported, {
    currentVersion: '1.2.3',
    getCurrentBuildId: () => 'aaaaaaaaaaaaaaaa',
  });
  assert.equal(await unsupported.isUpdateAvailable({
    version: '1.2.3',
    buildId: 'bbbbbbbbbbbbbbbb',
  }), false);
});

test('installed build identity is read from the packaged resources', () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-update-identity-'));
  fs.writeFileSync(path.join(resources, 'pi-studio-build.json'), JSON.stringify({
    version: '0.0.11',
    buildId: '1234567890abcdef',
    commit: 'abcdef123456',
  }));
  assert.deepEqual(readInstalledBuildIdentity(resources), {
    version: '0.0.11',
    buildId: '1234567890abcdef',
    commit: 'abcdef123456',
  });
  fs.rmSync(resources, { recursive: true, force: true });
});
