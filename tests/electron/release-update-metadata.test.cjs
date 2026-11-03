const assert = require('node:assert/strict');
const test = require('node:test');
const YAML = require('yaml');
const {
  stampUpdateMetadata,
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

test('native macOS build numbers are valid segmented integers', () => {
  assert.equal(buildNumberAt(Date.UTC(2026, 10, 4, 12, 34, 56)), '20261104123456');
});
