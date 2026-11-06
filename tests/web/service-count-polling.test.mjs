import test from 'node:test';
import assert from 'node:assert/strict';
import { pollServiceCount } from '../../web/src/shell/right-panel/service-count-polling.ts';
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  let visible = true; let listener; let sequence = 0;
  const timers = new Map(); const pending = []; const values = [];
  const dispose = pollServiceCount(() => new Promise((resolve, reject) => pending.push({ resolve, reject })), value => values.push(value), {
    isVisible: () => visible,
    onVisibilityChange: callback => { listener = callback; return () => { listener = undefined; }; },
    schedule: callback => { const id = ++sequence; timers.set(id, callback); return id; },
    cancel: id => timers.delete(id),
  });
  return { pending, timers, values, dispose, visibility(value) { visible = value; listener?.(); }, tick() { for (const [id, callback] of timers) { timers.delete(id); callback(); } }, hasListener: () => Boolean(listener) };
}
test('slow service reads never overlap periodic or visibility refreshes', async () => {
  const env = setup(); assert.equal(env.pending.length, 1); assert.equal(env.timers.size, 0);
  env.visibility(false); env.visibility(true); env.tick(); assert.equal(env.pending.length, 1);
  env.pending.shift().resolve(3); await flush(); assert.deepEqual(env.values, [3]); assert.equal(env.timers.size, 1);
  env.tick(); assert.equal(env.pending.length, 1); assert.equal(env.timers.size, 0); env.dispose();
});
test('hidden panels neither publish late results nor keep polling; resume refreshes immediately', async () => {
  const env = setup(); env.visibility(false); env.pending.shift().resolve(4); await flush();
  assert.deepEqual(env.values, []); assert.equal(env.timers.size, 0);
  env.visibility(true); assert.equal(env.pending.length, 1); env.pending.shift().resolve(5); await flush(); assert.deepEqual(env.values, [5]);
  env.visibility(false); assert.equal(env.timers.size, 0); env.dispose(); assert.equal(env.hasListener(), false);
});
test('disposed scope ignores late service counts and cleans scheduled work', async () => {
  const env = setup(); env.dispose(); env.pending.shift().resolve(9); await flush();
  assert.deepEqual(env.values, []); assert.equal(env.timers.size, 0); assert.equal(env.hasListener(), false);
  const failed = setup(); failed.pending.shift().reject(new Error('fixture')); await flush(); assert.deepEqual(failed.values, [0]); assert.equal(failed.timers.size, 1); failed.dispose(); assert.equal(failed.timers.size, 0);
});
