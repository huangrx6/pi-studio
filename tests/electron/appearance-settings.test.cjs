const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-appearance-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const {
  KEYS,
  RADIUS_PRESETS,
  getRadiusPreset,
  getRadiusStyle,
  normalizeRadiusStyle,
} = require('../../electron/core/app-settings.cjs');
const { closeStudioDatabase, getStudioDatabase } = require('../../electron/core/studio-db.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('the Studio radius preset is persisted for native surfaces and menu-bar UI', () => {
  assert.equal(normalizeRadiusStyle('invalid'), 'standard');
  assert.deepEqual(RADIUS_PRESETS.standard, {
    tag: 4,
    control: 8,
    card: 12,
    panel: 16,
    round: 999,
  });

  getStudioDatabase().setSetting(KEYS.radiusStyle, 'soft');
  assert.equal(getRadiusStyle(), 'soft');
  assert.deepEqual(getRadiusPreset(), {
    tag: 6,
    control: 10,
    card: 16,
    panel: 22,
    round: 999,
  });

  getStudioDatabase().setSetting(KEYS.radiusStyle, 'not-a-style');
  assert.equal(getRadiusStyle(), 'standard');
  assert.deepEqual(getRadiusPreset('square'), {
    tag: 0,
    control: 0,
    card: 0,
    panel: 0,
    round: 0,
  });
});
