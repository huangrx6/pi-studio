const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createKeepAwake, createMacLidControl } = require('../../electron/main/capabilities/keep-awake/index.cjs');

const id = 'builtin:studio-keep-awake';
const nextTick = () => new Promise(resolve => setImmediate(resolve));
const task = (status, extra) => ({ kind: 'pi.tool', state: { status }, ...extra });
const graph = (...tasks) => ({ tasks: Object.fromEntries(tasks.map((node, index) => [index, node])) });

function fixture({ saved = 'off', enabled = true, createLidControl } = {}) {
  const events = new EventEmitter();
  const monitor = new EventEmitter();
  const locks = new Set();
  const releases = [];
  let next = 0;
  const blocker = {
    start(type) {
      assert.equal(type, 'prevent-app-suspension');
      locks.add(next);
      return next++;
    },
    stop(value) { releases.push(value); locks.delete(value); },
    isStarted: value => locks.has(value),
  };
  const db = {
    getExtension: () => ({ enabled }),
    getSettingWithRecovery: (_key, _fallback, normalize) => normalize(saved),
    setSetting(_key, value) { saved = value; },
  };
  const runtime = createKeepAwake({ db, blocker, powerMonitor: monitor, createLidControl, onEnabled(name, fn) {
    events.on(name, fn);
    return () => events.off(name, fn);
  } });
  const control = runtime.dataSources[id + '/control'];
  return { runtime, blocker, locks, releases, control, monitor, db, saved: () => saved,
    state: () => control.read().viewData, mode: mode => control.invoke({}, 'setMode', { mode }),
    enable: value => events.emit(id, value) };
}

function graphWatch(initial = graph()) {
  const end = Promise.withResolvers();
  let listener;
  return {
    closed: end.promise, value: initial, stopped: false,
    start(fn) { listener = fn; },
    send(...tasks) { listener({ kind: 'value', value: graph(...tasks) }); },
    stop() { this.stopped = true; end.resolve({ kind: 'stopped' }); return end.promise; },
    fail() { end.resolve({ kind: 'failed' }); },
  };
}

test('the device preference survives disabling, while native ID zero and all listeners are released', () => {
  const f = fixture({ saved: 'invalid' });
  assert.equal(f.state().mode, 'off');
  const snapshots = [];
  const off = f.control.subscribe({}, value => snapshots.push(value.viewData.label));
  const wanted = f.mode('always');
  assert.equal(wanted.active, true);
  assert.equal(f.saved(), 'always');
  assert.deepEqual([...f.locks], [0]);
  f.mode('always');
  assert.deepEqual([...f.locks], [0]);
  f.enable(false);
  assert.deepEqual(f.releases, [0]);
  assert.throws(() => f.mode('off'), /停用/);
  assert.equal(f.saved(), 'always');
  f.enable(true);
  assert.deepEqual([...f.locks], [1]);
  f.locks.clear(); // The native handle can be lost across system sleep.
  f.monitor.emit('resume');
  assert.deepEqual([...f.locks], [2]);
  assert.throws(() => f.mode('display'), /模式无效/);
  assert.throws(() => f.control.invoke({}, 'start', {}), /不支持/);
  off();
  f.runtime.close();
  assert.equal(f.locks.size, 0);
  assert.equal(f.monitor.listenerCount('resume'), 0);
  assert.deepEqual(snapshots, ['关闭 · 未生效', '开启 · 已生效', '开启 · 未生效', '开启 · 已生效']);
  const disabled = fixture({ saved: 'always', enabled: false });
  assert.equal(disabled.locks.size, 0);
  disabled.runtime.close();
});

test('agent mode follows initial, overlapping and resumed Durable work from both harnesses', async () => {
  const f = fixture();
  const main = graphWatch(graph(task('running')));
  const temp = graphWatch();
  let seen = 0;
  f.runtime.addHarness({ watchTaskGraph: async () => { seen++; return main; } }, {});
  const removeTemp = f.runtime.addHarness({ watchTaskGraph: async () => { seen++; return temp; } }, {});
  assert.equal(seen, 0);
  f.mode('agent');
  await nextTick();
  assert.equal(f.state().active, true);
  temp.send(task('pending'));
  main.send(task('waiting'), task('completing'));
  assert.deepEqual([...f.locks], [0]);
  removeTemp();
  assert.equal(temp.stopped, true);
  assert.equal(f.state().active, false);
  main.send(task('running', { blocked: 'missing_task' }), task('sleeping'));
  assert.equal(f.state().status, '等待任务');
  main.send(task('sleeping', { kind: 'pi.generation' }));
  assert.equal(f.state().active, true);
  main.send();
  assert.equal(f.state().active, false);
  main.send(task('running'));
  f.mode('off');
  assert.equal(main.stopped, true);
  assert.equal(f.locks.size, 0);
  main.send(task('running'));
  assert.equal(f.locks.size, 0);
  f.runtime.close();
});

test('a delayed graph cannot reacquire after disable or shutdown; a failed graph can be retried', async () => {
  const f = fixture({ saved: 'agent' });
  const attaching = Promise.withResolvers();
  const stale = graphWatch(graph(task('running')));
  const current = graphWatch(graph(task('running')));
  const replacement = graphWatch();
  const watches = [attaching.promise, Promise.resolve(current), Promise.resolve(replacement)];
  f.runtime.addHarness({ watchTaskGraph: () => watches.shift() }, {});
  f.enable(false);
  f.enable(true);
  attaching.resolve(stale);
  await nextTick();
  assert.equal(stale.stopped, true);
  assert.deepEqual([...f.locks], [0]);
  current.fail();
  await nextTick();
  assert.equal(f.locks.size, 0);
  assert.match(f.state().error, /任务状态/);
  f.mode('agent');
  await nextTick();
  assert.equal(f.state().status, '等待任务');
  const last = Promise.withResolvers();
  f.runtime.addHarness({ watchTaskGraph: () => last.promise }, {});
  f.runtime.close();
  const late = graphWatch(graph(task('pending')));
  last.resolve(late);
  await nextTick();
  assert.equal(late.stopped, true);
  assert.equal(f.locks.size, 0);
});

test('agent subscription startup keeps the settled footer label and plain text appearance', async () => {
  const f = fixture();
  const graphReady = Promise.withResolvers();
  f.runtime.addHarness({ watchTaskGraph: () => graphReady.promise }, {});
  const updates = [];
  f.runtime.dataSources[id + '/summary'].subscribe({}, blocks => updates.push(blocks));
  f.mode('agent');
  graphReady.resolve(graphWatch());
  await nextTick();
  assert.deepEqual(updates, [[{ kind: 'text', text: '关闭 · 未生效' }], [{ kind: 'text', text: '代理 · 等待任务' }]]);
  f.runtime.close();
});

test('lid authorization is separate, follows actual agent work, and ends on heat, disable and quit', async () => {
  const sessions = [];
  const f = fixture({ createLidControl: options => createMacLidControl({ ...options, probe: async () => true, open(report) {
    const session = { wanted: false, report, setWanted(value) { this.wanted = value; }, stop: reason => report(reason) };
    sessions.push(session);
    return session;
  } }) });
  const lid = enabled => f.control.invoke({}, 'setLidEnabled', { enabled });
  const watch = graphWatch();
  f.runtime.addHarness({ watchTaskGraph: async () => watch }, {});
  await nextTick();
  f.mode('always');
  assert.equal(f.state().lid.phase, 'off');
  assert.equal(sessions.length, 0);
  assert.throws(() => lid('yes'));
  assert.equal(lid(true).lid.phase, 'authorizing');
  assert.equal(sessions[0].wanted, true);
  sessions[0].report('active');
  f.mode('agent');
  await nextTick();
  assert.equal(sessions[0].wanted, false);
  watch.send(task('running'));
  assert.equal(sessions[0].wanted, true);
  watch.send();
  assert.equal(sessions[0].wanted, false);
  f.monitor.emit('thermal-state-change', { state: 'serious' });
  assert.equal(f.state().lid.phase, 'thermal');
  lid(true);
  f.enable(false);
  assert.equal(f.state().lid.phase, 'off');
  assert.throws(() => lid(true));
  f.enable(true);
  assert.equal(sessions.length, 2);
  lid(true);
  sessions[2].report('low');
  assert.equal(f.state().lid.enabled, false);
  lid(true);
  let stopped;
  sessions[3].stop = reason => { stopped = reason; };
  f.runtime.close();
  assert.equal(stopped, 'off');
  assert.equal(f.monitor.listenerCount('thermal-state-change'), 0);
});

test('native and storage failures leave an honest, recoverable status', () => {
  const f = fixture();
  const start = f.blocker.start;
  f.blocker.start = () => { throw new Error('native failure'); };
  f.mode('always');
  assert.equal(f.state().active, false);
  assert.match(f.state().error, /防休眠请求/);
  f.blocker.start = start;
  assert.equal(f.mode('always').active, true);
  f.db.setSetting = () => { throw new Error('disk full'); };
  assert.throws(() => f.mode('off'), /disk full/);
  assert.equal(f.state().mode, 'always');
  f.runtime.close();
  assert.equal(f.locks.size, 0);
});
