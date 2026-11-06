import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecencyClock, nextRelativeTimeTick, relativeTime } from '../../web/src/shell/session-recency.ts';

test('relative labels preserve second, minute, hour and day boundaries', () => {
  for (const [elapsed, expected] of [
    [0, '0s'], [999, '0s'], [1_000, '1s'], [59_999, '59s'], [60_000, '1m'],
    [3_599_999, '59m'], [3_600_000, '1h'], [3_660_000, '1h1m'], [86_400_000, '1d'],
  ]) assert.equal(relativeTime(0, elapsed), expected);
  assert.equal(relativeTime(10_000, 0), '0s');
  assert.equal(relativeTime(Number.NaN, 0), '—');
});

test('next tick lands on the earliest visible label change without polling old timestamps', () => {
  assert.equal(nextRelativeTimeTick(0, 999), 1);
  assert.equal(nextRelativeTimeTick(0, 59_999), 1);
  assert.equal(nextRelativeTimeTick(0, 60_001), 59_999);
  assert.equal(nextRelativeTimeTick(0, 3_600_001), 59_999);
  assert.equal(nextRelativeTimeTick(0, 86_400_001), 86_399_999);
  assert.equal(nextRelativeTimeTick(10_000, 0), 11_000);
  assert.equal(nextRelativeTimeTick(Number.NaN, 0), null);
});

function fixture() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const ticks = [];
  const clock = createRecencyClock(0, value => ticks.push(value), {
    now: () => now,
    setTimeout(callback, delay) { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { clock, timers, ticks, setNow(value) { now = value; }, fire() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); now += timer.delay; timer.callback();
  } };
}

test('an inactive or offscreen clock creates no timer; repeated visibility events create only one', () => {
  const { clock, timers, ticks } = fixture();
  assert.equal(timers.size, 0);
  clock.setActive(false);
  assert.deepEqual(ticks, []);
  clock.setActive(true);
  clock.setActive(true);
  assert.equal(timers.size, 1);
  assert.deepEqual(ticks, [0]);
});

test('hiding cancels work and showing immediately catches up before scheduling the next boundary', () => {
  const { clock, timers, ticks, setNow, fire } = fixture();
  clock.setActive(true);
  fire();
  assert.deepEqual(ticks, [0, 1_000]);
  clock.setActive(false);
  assert.equal(timers.size, 0);
  setNow(125_000);
  clock.setActive(true);
  assert.equal(ticks.at(-1), 125_000);
  assert.equal([...timers.values()][0].delay, 55_000);
  clock.dispose();
  assert.equal(timers.size, 0);
});

test('a callback already queued before hiding cannot create a new timer after disposal', () => {
  const { clock, timers, ticks } = fixture();
  clock.setActive(true);
  const pending = [...timers.values()][0].callback;
  clock.dispose();
  pending();
  clock.setActive(true);
  assert.deepEqual(ticks, [0]);
  assert.equal(timers.size, 0);
});

test('a stale queued callback cannot duplicate the timer after a visibility round trip', () => {
  const { clock, timers, ticks, setNow } = fixture();
  clock.setActive(true);
  const stale = [...timers.values()][0].callback;
  clock.setActive(false);
  setNow(3_000);
  clock.setActive(true);
  stale();
  assert.deepEqual(ticks, [0, 3_000]);
  assert.equal(timers.size, 1);
});
