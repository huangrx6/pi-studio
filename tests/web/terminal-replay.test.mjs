import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreTerminalReplay } from '../../web/src/features/terminal/terminal-replay.ts';

test('replay waits for parsing before each resize and before allowing live output', async () => {
  const operations = [], parsed = [];
  const target = {
    reset() { operations.push('reset'); },
    resize(cols, rows) { operations.push(`resize ${cols} ${rows}`); },
    write(data, callback) { operations.push(data); parsed.push(callback); },
  };
  let done = false;
  const restoring = restoreTerminalReplay(target, {
    cols: 36, rows: 39, truncated: false,
    steps: [{ type: 'data', data: 'old-width ANSI' }, { type: 'resize', cols: 55, rows: 33 }, { type: 'data', data: 'new-width ANSI' }],
  }, () => true).then(value => { done = value; });
  assert.deepEqual(operations, ['reset', 'resize 36 39', 'old-width ANSI']); assert.equal(done, false);
  parsed.shift()(); await Promise.resolve();
  assert.deepEqual(operations, ['reset', 'resize 36 39', 'old-width ANSI', 'resize 55 33', 'new-width ANSI']);
  assert.equal(done, false); parsed.shift()(); await restoring; assert.equal(done, true);
});

test('unmount during parsing prevents remaining geometry changes and output', async () => {
  const operations = []; let current = true, parsed;
  const result = restoreTerminalReplay({
    reset() {}, resize(cols, rows) { operations.push([cols, rows]); }, write(data, callback) { operations.push(data); parsed = callback; },
  }, { cols: 36, rows: 39, truncated: false, steps: [{ type: 'data', data: 'first' }, { type: 'resize', cols: 55, rows: 33 }, { type: 'data', data: 'late' }] }, () => current);
  current = false; parsed();
  assert.equal(await result, false); assert.deepEqual(operations, [[36, 39], 'first']);
});
