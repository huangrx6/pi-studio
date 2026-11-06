const assert = require('node:assert/strict');
const test = require('node:test');
const { createTerminalReplay } = require('../../electron/services/terminal-replay.cjs');

test('replay preserves data and dimension ordering, coalescing only adjacent data', () => {
  const replay = createTerminalReplay({ cols: 80, rows: 24 });
  replay.append('first');
  replay.append('\x1b[');
  replay.append('31mred');
  replay.resize(80, 24);
  replay.resize(40, 24);
  replay.append('narrow');
  replay.resize(40, 12);
  replay.resize(40, 12);
  replay.append('short');
  assert.deepEqual(replay.snapshot(), {
    cols: 80, rows: 24, truncated: false,
    steps: [
      { type: 'data', data: 'first\x1b[31mred' },
      { type: 'resize', cols: 40, rows: 24 },
      { type: 'data', data: 'narrow' },
      { type: 'resize', cols: 40, rows: 12 },
      { type: 'data', data: 'short' },
    ],
  });
});

test('character trimming retains the recent suffix at its correct initial dimensions', () => {
  const replay = createTerminalReplay({ cols: 80, rows: 24, maxChars: 6 });
  replay.append('abcd');
  replay.resize(40, 12);
  replay.append('efgh');
  assert.deepEqual(replay.snapshot(), {
    cols: 80, rows: 24, truncated: true,
    steps: [{ type: 'data', data: 'cd' }, { type: 'resize', cols: 40, rows: 12 }, { type: 'data', data: 'efgh' }],
  });
  replay.append('ijkl');
  assert.deepEqual(replay.snapshot(), {
    cols: 40, rows: 12, truncated: true,
    steps: [{ type: 'data', data: 'ghijkl' }],
  });
});

test('step budget is bounded even for resize-only streams and updates initial geometry', () => {
  const replay = createTerminalReplay({ cols: 80, rows: 24, maxSteps: 2 });
  replay.resize(70, 24);
  replay.resize(60, 24);
  replay.resize(50, 24);
  assert.deepEqual(replay.snapshot(), {
    cols: 70, rows: 24, truncated: true,
    steps: [{ type: 'resize', cols: 60, rows: 24 }, { type: 'resize', cols: 50, rows: 24 }],
  });
  replay.append('current');
  replay.append(' output');
  const snapshot = replay.snapshot();
  assert.equal(snapshot.cols, 60);
  assert.equal(snapshot.steps.length, 2);
  assert.equal(snapshot.steps[1].data, 'current output');
});

test('oversized chunks retain a bounded suffix without splitting a surrogate pair', () => {
  const replay = createTerminalReplay({ cols: 80, rows: 24, maxChars: 3 });
  replay.append('prefix😀ab');
  assert.deepEqual(replay.snapshot().steps, [{ type: 'data', data: 'ab' }]);
  assert.equal(replay.snapshot().truncated, true);
  const one = createTerminalReplay({ cols: 80, rows: 24, maxChars: 1 });
  one.append('😀');
  assert.deepEqual(one.snapshot().steps, []);
  one.append('x');
  assert.deepEqual(one.snapshot().steps, [{ type: 'data', data: 'x' }]);
});

test('snapshots are JSON-safe independent copies, including later merged data', () => {
  const replay = createTerminalReplay({ cols: 80, rows: 24 });
  replay.append('one');
  const first = replay.snapshot();
  replay.append('two');
  replay.resize(40, 12);
  assert.deepEqual(first.steps, [{ type: 'data', data: 'one' }]);
  first.steps[0].data = 'external mutation';
  first.steps.push({ type: 'resize', cols: 1, rows: 1 });
  const next = replay.snapshot();
  assert.deepEqual(next, JSON.parse(JSON.stringify(next)));
  assert.deepEqual(next.steps, [{ type: 'data', data: 'onetwo' }, { type: 'resize', cols: 40, rows: 12 }]);
});

test('empty data does not consume steps and invalid budgets cannot disable bounds', () => {
  const replay = createTerminalReplay({ cols: 80, rows: 24, maxSteps: 1 });
  replay.append('');
  assert.deepEqual(replay.snapshot().steps, []);
  for (const maxSteps of [0, -1, Infinity, 1.5]) {
    assert.throws(() => createTerminalReplay({ cols: 80, rows: 24, maxSteps }), RangeError);
  }
});
