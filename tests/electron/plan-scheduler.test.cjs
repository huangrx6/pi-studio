const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const { normalizeSchedule, occurrence } = require('../../electron/main/core/plan-schedule.cjs');
const { PlanStore } = require('../../electron/main/core/plan-store.cjs');
const { PlanScheduler } = require('../../electron/main/services/plan-scheduler.cjs');

const start = Date.parse('2026-01-01T00:00:00Z');
const minute = 60_000;
const daily = { kind: 'daily', zone: 'UTC', time: '09:00' };
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plan-'));
  const studio = createStudioDatabase(path.join(cwd, 'studio.sqlite'));
  studio.upsertWorkspace({ cwd });
  t.after(() => { studio.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const store = new PlanStore(studio);
  const input = { name: 'Demo', workspace: cwd, prompt: 'Read recent changes', schedule: daily };
  return { studio, store, cwd, input };
}

test('calendar rules preserve civil time, skip DST gaps and fire only once at a repeated local time', () => {
  const iso = (rule, at, opts) => new Date(occurrence(normalizeSchedule(rule), Date.parse(at), opts)).toISOString();
  const zone = 'America/New_York';
  assert.equal(iso({ kind: 'daily', zone, time: '02:30' }, '2026-03-07T08:00Z'), '2026-03-09T06:30:00.000Z');
  assert.equal(iso({ kind: 'daily', zone, time: '01:30' }, '2026-11-01T04:00Z'), '2026-11-01T05:30:00.000Z');
  assert.equal(iso({ kind: 'daily', zone, time: '01:30' }, '2026-11-01T05:30Z'), '2026-11-02T06:30:00.000Z');
  assert.equal(iso({ kind: 'daily', zone, time: '01:30' }, '2026-11-01T06:40Z', { previous: true }), '2026-11-01T05:30:00.000Z');
  assert.equal(iso({ kind: 'weekly', days: [1, 5], zone: 'Asia/Kathmandu', time: '09:15' }, '2026-01-01T23:00Z'), '2026-01-02T03:30:00.000Z');
  const monthly = { kind: 'monthly', zone: 'Asia/Shanghai', time: '09:00', day: 31 };
  assert.equal(iso(monthly, '2026-01-31T01:00Z'), '2026-03-31T01:00:00.000Z');
  assert.equal(iso(monthly, '2026-03-05T01:00Z', { previous: true }), '2026-01-31T01:00:00.000Z');
  assert.equal(iso({ ...monthly, day: 'last' }, '2028-02-01T00:00Z'), '2028-02-29T01:00:00.000Z');
  assert.equal(occurrence({ ...monthly, endDate: '2026-02-28' }, Date.parse('2026-02-01T00:00Z')), null);
  const rule = { ...daily, kind: 'once', date: '2026-01-01' };
  assert.equal(occurrence(rule, start + 9 * 60 * minute), null);
  for (const invalid of [{ ...rule, date: '2026-02-30' }, { ...daily, time: '24:10' }, { ...daily, zone: '?' },
    { ...daily, kind: 'weekly', days: [] }, { ...monthly, day: 0 }, { ...daily, kind: 'interval', minutes: 0 }]) {
    assert.throws(() => normalizeSchedule(invalid));
  }
});

test('due collection is atomic, coalesces missed slots and respects overlap, end dates, pause and one-time completion', t => {
  const { store, input } = fixture(t);
  const interval = { kind: 'interval', zone: 'UTC', minutes: 10 };
  const id = store.save({ ...input, schedule: interval }, start);
  assert.equal(store.preview(interval, id, start + 2 * minute), start + 10 * minute);
  const wake = start + 37 * minute;
  assert.equal(store.collectDue(wake), true);
  assert.equal(store.collectDue(wake), false);
  assert.equal(store.history().items[0].dueAt, start + 30 * minute);
  assert.equal(store.nextAlarm(), start + 40 * minute);
  assert.throws(() => store.runNow(id, wake), /排队/);
  const run = store.claim(wake);
  assert.equal(new PlanStore(store.studio).claim(wake + minute).id, run.id);
  store.collectDue(start + 45 * minute);
  assert.equal(store.history().items.length, 1);
  store.finish(run.id, 'succeeded', 'done', wake);
  const manualId = store.runNow(id, start + 46 * minute);
  assert.equal(store.nextAlarm(), start + 50 * minute);
  store.setPaused(id, true, wake);
  assert.equal(store.nextAlarm(), null);
  assert.equal(store.preview(interval, id, wake), wake + 10 * minute);
  assert.equal(store.activeRun(id).id, manualId);
  store.requestStop(manualId, 'stop', wake);
  store.setPaused(id, false, wake);
  assert.equal(store.nextAlarm(), wake + 10 * minute);
  store.collectDue(wake + 10 * minute);
  store.setPaused(id, true, wake + 11 * minute);
  assert.equal(store.activeRun(id), undefined);
  store.remove(id);
  assert.ok(store.history().items.every(run => run.planId === null));

  const once = store.save({ ...input, schedule: { ...daily, kind: 'once', date: '2026-01-01' } }, start);
  const expired = store.save({ ...input, schedule: { ...daily, endDate: '2026-01-01' } }, start);
  store.collectDue(start + 3 * 86_400_000);
  assert.equal(store.history(undefined, once).items.length, 1);
  assert.equal(store.history(undefined, expired).items.length, 0);
  assert.ok(store.listPlans().every(plan => plan.status === 'completed' && plan.nextAt === null));
  assert.equal(store.preview(store.listPlans().find(plan => plan.id === once).schedule, once, start), null);
});

test('the weekly agenda combines actual scheduled runs with the first future occurrence on each local day', t => {
  const { store, input } = fixture(t);
  const created = Date.parse('2025-12-30T23:58Z');
  const now = Date.parse('2026-01-01T09:05Z');
  const boundaries = Array.from({ length: 8 }, (_, i) => Date.parse('2025-12-29T00:00Z') + i * 86_400_000);
  const id = store.save({ ...input, schedule: { kind: 'interval', minutes: 1, zone: 'UTC', endDate: '2026-01-02' } }, created);
  for (const [offset, status] of [[1, 'succeeded'], [2, 'failed'], [3, 'cancelled']]) {
    const at = created + offset * minute;
    store.collectDue(at);
    store.finish(store.claim(at).id, status, '', at);
  }
  store.runNow(id, now - minute);
  store.finish(store.claim(now - minute).id, 'succeeded', '', now);
  store.collectDue(now);
  store.finish(store.claim(now).id, 'succeeded', '', now);
  const snapshot = store.week(boundaries, now);
  assert.deepEqual(snapshot.plans.map(plan => plan.id), [id]);
  assert.deepEqual(snapshot.days.map(entries => entries.map(item => [item.status, item.runs])), [
    [], [['succeeded', 1]], [['cancelled', 2]], [['succeeded', 1], ['scheduled', 0]], [['scheduled', 0]], [], [],
  ]);
  assert.equal(snapshot.days[3][1].at, now + minute);
  assert.equal(snapshot.days[4][0].at, boundaries[4]);
  store.setPaused(id, true, now);
  assert.deepEqual(store.week(boundaries, now).days[4], []);
  store.remove(id);
  const archived = store.week(boundaries, now);
  assert.equal(archived.days[3][0].planId, null);
  assert.deepEqual(archived.plans, []);
  assert.throws(() => store.week([], now), /日期范围/);
  assert.throws(() => store.week([...boundaries].reverse(), now), /日期范围/);
});

test('the calendar uses the viewing week’s local midnights while rules keep the execution time zone', t => {
  const { store, input } = fixture(t);
  // New York observes a 23-hour Sunday. Shanghai's Monday morning falls on that Sunday evening.
  const localMidnights = ['03-02T05', '03-03T05', '03-04T05', '03-05T05', '03-06T05', '03-07T05', '03-08T05', '03-09T04']
    .map(part => Date.parse('2026-' + part + ':00Z'));
  const now = localMidnights[0];
  store.save({ ...input, schedule: { ...daily, kind: 'weekly', zone: 'Asia/Shanghai', days: [1], time: '09:00' } }, now);
  store.save({ ...input, name: 'DST gap', schedule: { ...daily, time: '02:30', zone: 'America/New_York' } }, now);
  const { days } = store.week(localMidnights, now);
  assert.ok(days.slice(0, 6).every(day => day.length === 1 && day[0].name === 'DST gap'));
  assert.deepEqual(days[6].map(entry => [entry.name, entry.at]), [['Demo', Date.parse('2026-03-09T01:00Z')]]);
});

test('one alarm serves all plans, no timer survives idle or shutdown, cancellation frees the sole execution slot', async t => {
  const { store, input } = fixture(t);
  const timers = new Map(), executions = [];
  let now = start;
  const scheduler = new PlanScheduler({
    store, now: () => now,
    setTimer(fn, ms) { const key = {}; timers.set(key, { fn, ms }); assert.equal(timers.size, 1); return key; },
    clearTimer(key) { timers.delete(key); },
    execute(run, { signal }) {
      executions.push(run.id);
      return new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  scheduler.start();
  assert.equal(timers.size, 0);
  const first = store.save(input, now);
  const second = store.save(input, now);
  scheduler.tick();
  assert.equal(timers.values().next().value.ms, 9 * 60 * minute);
  const runA = store.runNow(first, now), runB = store.runNow(second, now);
  scheduler.tick();
  await Promise.resolve();
  assert.deepEqual(executions, [runA]);
  assert.equal(timers.values().next().value.ms, 60 * minute);
  const completion = scheduler.active.done;
  now += 60 * minute;
  scheduler.tick();
  await completion;
  await Promise.resolve();
  assert.deepEqual(executions, [runA, runB]);
  assert.match(store.history(undefined, first).items[0].detail, /60 分钟/);
  assert.equal(store.history(undefined, first).items[0].status, 'failed');
  await scheduler.stop();
  assert.equal(timers.size, 0);
  assert.equal(scheduler.active, null);
  assert.equal(store.history(undefined, second).items[0].status, 'cancelled');
});

test('queued instructions are immutable, history is bounded per page, and removing a workspace clears its schedules', async t => {
  const { studio, store, cwd, input } = fixture(t);
  const id = store.save(input, start);
  const first = store.runNow(id, start);
  store.save({ ...input, id, name: 'Updated', prompt: 'New instructions' }, start);
  assert.throws(() => store.remove(id), /停止/);
  assert.equal(store.claim(start).prompt, input.prompt);
  store.finish(first, 'succeeded', 'ok', start);
  for (let i = 0; i < 54; i++) {
    const run = store.runNow(id, start);
    store.claim(start);
    store.finish(run, 'succeeded', 'summary', start);
  }
  const page = store.history(undefined, id), next = store.history(page.cursor, id);
  assert.equal(page.items.length, 50);
  assert.equal(next.items.length, 5);
  assert.equal(next.cursor, null);
  assert.equal(new Set([...page.items, ...next.items].map(run => run.id)).size, 55);
  const removalTime = start + minute;
  const run = store.runNow(id, removalTime);
  const scheduler = new PlanScheduler({ store, execute: (_run, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), now: () => removalTime });
  scheduler.start();
  await scheduler.removingWorkspace(cwd, () => {
    assert.equal(store.history(undefined, id).items.find(r => r.id === run).status, 'cancelled');
    studio.removeWorkspace(cwd);
  });
  assert.deepEqual(store.listPlans(), []);
  assert.equal(store.history().items.length, 0);
  assert.equal(scheduler.alarm, null);
  await scheduler.stop();
});
