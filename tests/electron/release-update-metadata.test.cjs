const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const {
  stampUpdateMetadata,
  stampUpdateMetadataFiles,
} = require('../../tools/release/stamp-update-metadata.cjs');
const { buildNumberAt } = require('../../tools/release/build-identity.cjs');

test('updater metadata receives a build id without losing artifact fields', () => {
  const source = [
    'version: 0.0.11',
    'files:',
    '  - url: Pi-Studio-0.0.11-arm64.zip',
    '    sha512: signed-sha',
    'path: Pi-Studio-0.0.11-arm64.zip',
    'releaseDate: 2026-11-04T00:00:00.000Z',
    '',
  ].join('\n');
  const parsed = YAML.parse(stampUpdateMetadata(source, '1234567890abcdef'));
  assert.equal(parsed.buildId, '1234567890abcdef');
  assert.equal(parsed.version, '0.0.11');
  assert.equal(parsed.files[0].sha512, 'signed-sha');
  assert.equal(parsed.path, 'Pi-Studio-0.0.11-arm64.zip');
});

test('updater metadata rejects an invalid build id', () => {
  assert.throws(
    () => stampUpdateMetadata('version: 1.0.0\n', '../unsafe'),
    /构建标识无效/,
  );
});

test('Windows and Mac rebuilds stamp only their own update feed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-release-feed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const release = path.join(root, 'release');
  fs.mkdirSync(release);
  const mac = path.join(release, 'latest-mac.yml');
  const win = path.join(release, 'latest.yml');
  const initial = 'version: 0.0.6\n';
  fs.writeFileSync(mac, initial);
  fs.writeFileSync(win, initial);
  stampUpdateMetadataFiles(root, 'aaaaaaaaaaaaaaaa', 'win32');
  assert.equal(fs.readFileSync(mac, 'utf8'), initial);
  stampUpdateMetadataFiles(root, 'bbbbbbbbbbbbbbbb', 'darwin');
  assert.equal(YAML.parse(fs.readFileSync(win, 'utf8')).buildId, 'aaaaaaaaaaaaaaaa');
  assert.equal(YAML.parse(fs.readFileSync(mac, 'utf8')).buildId, 'bbbbbbbbbbbbbbbb');
});

test('native macOS build numbers are valid segmented integers', () => {
  assert.equal(buildNumberAt(Date.UTC(2026, 10, 4, 12, 34, 56)), '20261104123456');
});
