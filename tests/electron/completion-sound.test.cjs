const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  MACOS_AFPLAY,
  MACOS_COMPLETION_SOUND,
  playCompletionSound,
} = require('../../electron/completion-sound.cjs');

test('macOS completion sound uses the fixed system player and falls back once on spawn failure', () => {
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => calls.push(['unref']);
  let fallbackCount = 0;
  const played = playCompletionSound({
    platform: 'darwin',
    spawnProcess: (...args) => {
      calls.push(args);
      return child;
    },
    beep: () => { fallbackCount += 1; },
  });

  assert.equal(played, true);
  assert.deepEqual(calls[0], [
    MACOS_AFPLAY,
    [MACOS_COMPLETION_SOUND],
    { stdio: 'ignore', windowsHide: true },
  ]);
  child.emit('error', new Error('missing player'));
  child.emit('error', new Error('duplicate error'));
  assert.equal(fallbackCount, 1);
  assert.deepEqual(calls.at(-1), ['unref']);
});

test('other platforms retain the native beep fallback', () => {
  let beeps = 0;
  assert.equal(playCompletionSound({
    platform: 'win32',
    beep: () => { beeps += 1; },
  }), true);
  assert.equal(beeps, 1);
  assert.equal(playCompletionSound({ platform: 'linux' }), false);
});
