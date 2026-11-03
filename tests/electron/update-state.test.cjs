const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  initialUpdateState,
  normalizeReleaseNotes,
  reduceUpdateState,
} = require('../../electron/update-state.cjs');

test('update state follows check, availability and download lifecycle', () => {
  let state = initialUpdateState('1.2.3', 'aaaaaaaaaaaaaaaa');
  state = reduceUpdateState(state, { type: 'checking' });
  assert.equal(state.state, 'checking');

  state = reduceUpdateState(state, {
    type: 'available',
    updateKind: 'same-version',
    info: {
      version: '1.2.3',
      buildId: 'bbbbbbbbbbbbbbbb',
      releaseName: 'A quieter workspace',
      releaseNotes: '<p>Better <strong>updates</strong>.</p>',
      releaseDate: '2026-10-29T00:00:00.000Z',
    },
  });
  assert.equal(state.state, 'available');
  assert.equal(state.latestVersion, '1.2.3');
  assert.equal(state.latestBuildId, 'bbbbbbbbbbbbbbbb');
  assert.equal(state.updateKind, 'same-version');
  assert.equal(state.releaseNotes, 'Better updates.');

  state = reduceUpdateState(state, { type: 'progress', progress: {
    percent: 42.5,
    transferred: 425,
    total: 1000,
    bytesPerSecond: 120,
  } });
  assert.equal(state.state, 'downloading');
  assert.equal(state.progress, 42.5);
  assert.equal(state.bytesPerSecond, 120);

  // A delayed progress event must not move the visible bar backwards.
  state = reduceUpdateState(state, { type: 'progress', progress: { percent: 20 } });
  assert.equal(state.progress, 42.5);

  state = reduceUpdateState(state, { type: 'downloaded', info: { version: '1.2.3', buildId: 'bbbbbbbbbbbbbbbb' } });
  assert.equal(state.state, 'downloaded');
  assert.equal(state.progress, 100);
  assert.equal(state.updateKind, 'same-version');
});

test('up-to-date, errors and unsupported states remain actionable', () => {
  let state = reduceUpdateState(initialUpdateState('2.0.0'), {
    type: 'up-to-date',
    info: { version: '2.0.0' },
  });
  assert.equal(state.state, 'up-to-date');
  assert.equal(state.latestBuildId, undefined);
  assert.equal(state.updateKind, undefined);
  assert.equal(state.error, undefined);

  state = reduceUpdateState(state, { type: 'error', error: 'network offline' });
  assert.equal(state.state, 'error');
  assert.equal(state.error, 'network offline');

  state = reduceUpdateState(state, { type: 'unsupported', error: 'packaged builds only' });
  assert.equal(state.state, 'unsupported');
  assert.equal(state.error, 'packaged builds only');
});

test('release notes are plain text with script contents removed', () => {
  assert.equal(
    normalizeReleaseNotes('<h2>Changes</h2><script>alert(1)</script><ul><li>Faster</li></ul>'),
    'Changes\n• Faster',
  );
  assert.match(normalizeReleaseNotes([{ note: 'First' }, { note: 'Second' }]), /First\n\nSecond/);
});
