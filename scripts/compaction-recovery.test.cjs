const { test } = require('node:test');
const assert = require('node:assert/strict');
const { watchCompactionRecovery } = require('../electron/services/compaction-recovery.cjs');

function fixture(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000 });
  const session = { isCompacting: true, isStreaming: true };
  const events = [];
  const stop = watchCompactionRecovery(session, { onCompacted: () => events.push('compacted'), onComplete: () => events.push('done') });
  t.after(stop);
  const tick = (ms) => { for (let i = 0; i < ms; i += 250) t.mock.timers.tick(250); };
  return { session, events, tick, stop };
}

test('finished compaction is reported before resumed generation ends, even for a long task', t => {
  const { session, events, tick } = fixture(t);
  tick(360000); assert.deepEqual(events, []);
  session.isCompacting = false; session.isStreaming = false;
  tick(1000); assert.deepEqual(events, ['compacted']);
  session.isStreaming = true; tick(360000); assert.deepEqual(events, ['compacted']);
  session.isStreaming = false; tick(1000); assert.deepEqual(events, ['compacted', 'done']);
  tick(1000); assert.equal(events.length, 2);
});

test('no continuation settles after the idle grace period; aborted original stream does not skip grace', t => {
  const { session, events, tick } = fixture(t);
  tick(1000); session.isCompacting = false; session.isStreaming = false;
  tick(4000); assert.deepEqual(events, ['compacted']);
  tick(1500); assert.deepEqual(events, ['compacted', 'done']);
});

test('repeated compaction and disposal do not publish a premature done', t => {
  const { session, events, tick, stop } = fixture(t);
  session.isCompacting = false; tick(1000);
  session.isCompacting = true; session.isStreaming = false; tick(10000);
  assert.deepEqual(events, ['compacted']);
  session.isCompacting = false; tick(1000); assert.deepEqual(events, ['compacted', 'compacted']);
  stop(); tick(10000); assert.equal(events.length, 2);
});

test('IPC recovery resolves its pending prompt and unsubscribes after done', async t => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const { createRequire } = require('node:module');
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000 });
  const file = path.join(__dirname, '../electron/ipc/sessions.cjs'), nativeRequire = createRequire(file);
  const handlers = new Map(), sent = [];
  let listener, unsubscribed = 0;
  const session = {
    isCompacting: false, isStreaming: false,
    messages: [{ role: 'assistant', stopReason: 'aborted' }],
    subscribe(fn) { listener = fn; return () => { unsubscribed++; }; },
    async prompt() {
      session.isCompacting = true; listener({type:'compaction_start'});
      // Completion can precede the aborted prompt resolving.
      session.isCompacting = false; listener({type:'compaction_end'});
    },
  };
  const manager = { getEntries: () => [{type:'message',message:{role:'user'}}] };
  const noop = () => {};
  const deps = {
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name,fn), on: noop } },
    '../services/sessions.cjs': { findManager: async () => ({manager,cwd:'/fixture'}), ensureAgent: async () => session, updateSessionSummary: noop, invalidateIndex: noop, forgetDetail: noop, dropDraft: noop, indexSessions: async () => { throw new Error("index temporarily unavailable"); } },
    '../services/workspace.cjs': { fileReferenceContext: async () => [] },
    '../services/attachments.cjs': { attachmentContext: async () => [] },
    '../services/auto-title.cjs': { createAutoTitleGenerator: () => ({generate:noop}) },
    '../services/turn-diff.cjs': { beginTurn: async () => null },
    '../core/state.cjs': {}, '../services/extensions.cjs': {}, '../sidebar-state.cjs': {},
  };
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'), {module, require: name => name in deps ? deps[name] : nativeRequire(name), setInterval, clearInterval, setTimeout, clearTimeout, Date, console});
  module.exports.registerSessionsIpc();
  let settled = false;
  const result = handlers.get('pi:prompt')({sender:{send:(channel,payload)=>sent.push({channel,payload})}}, {sessionId:'demo',requestId:'r',text:'continue'}).then(() => { settled = true; });
  for (let i=0;i<20;i++) await Promise.resolve();
  const interrupted = sent.find(event => event.payload?.type === 'compaction-interrupted');
  assert.equal(interrupted?.payload.compacting, false);
  assert.equal(settled, false);
  for (let i=0;i<24;i++) t.mock.timers.tick(250);
  for (let i=0;i<20;i++) await Promise.resolve();
  assert.equal(settled, true, 'the IPC promise must not hang after the recovered run');
  await result;
  assert.equal(unsubscribed, 1);
  assert.equal(sent.filter(event => event.payload?.type === 'done').length, 1);
});

test('busy Agent accepts one follow-up and keeps the IPC open until the run settles', async t => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const { createRequire } = require('node:module');
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000 });
  const file = path.join(__dirname, '../electron/ipc/sessions.cjs'), nativeRequire = createRequire(file);
  const handlers = new Map(), sent = [];
  let listener, unsubscribed = 0;
  const session = {
    isCompacting: false, isStreaming: false,
    messages: [{ role: 'assistant', stopReason: 'aborted' }],
    subscribe(fn) { listener = fn; return () => { unsubscribed++; }; },
    async prompt(text, options) {
      assert.equal(options.streamingBehavior, 'followUp');
      assert.equal(text, 'continue');
      session.isStreaming = true;
      options.preflightResult('queued');
    },
  };
  const manager = { getEntries: () => [{type:'message',message:{role:'user'}}] };
  const noop = () => {};
  const deps = {
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name,fn), on: noop } },
    '../services/sessions.cjs': { detail: async () => ({id:'demo',title:'demo',messages:[]}), findManager: async () => ({manager,cwd:'/fixture'}), ensureAgent: async () => session, updateSessionSummary: noop, invalidateIndex: noop, forgetDetail: noop, dropDraft: noop, indexSessions: async () => { throw new Error("index temporarily unavailable"); } },
    '../services/workspace.cjs': { fileReferenceContext: async () => [] },
    '../services/attachments.cjs': { attachmentContext: async () => [] },
    '../services/auto-title.cjs': { createAutoTitleGenerator: () => ({generate:noop}) },
    '../services/turn-diff.cjs': { beginTurn: async () => null },
    '../core/state.cjs': { agentSessions: new Map([['demo',session]]), readConfig: () => ({}), configPath: () => '/fixture' }, '../services/extensions.cjs': {}, '../sidebar-state.cjs': {},
  };
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'), {module, require: name => name in deps ? deps[name] : nativeRequire(name), setInterval, clearInterval, setTimeout, clearTimeout, Date, console});
  module.exports.registerSessionsIpc();
  let settled = false;
  const result = handlers.get('pi:prompt')({sender:{send:(channel,payload)=>sent.push({channel,payload})}}, {sessionId:'demo',requestId:'r',text:'continue'}).then(() => { settled = true; });
  for (let i=0;i<20;i++) await Promise.resolve();
  const interrupted = sent.find(event => event.payload?.type === 'compaction-interrupted');
  assert.equal(interrupted?.payload.compacting, false);
  assert.equal(settled, false);
  const running = await handlers.get('pi:session')({},'demo');
  assert.equal(running.running, true); assert.equal(running.requestId, 'r');
  for (let i=0;i<8;i++) t.mock.timers.tick(250);
  assert.equal(settled, false);
  assert.equal(sent.filter(event => event.payload?.type === 'run-attached').length, 1);
  session.isStreaming = false;
  for (let i=0;i<24;i++) t.mock.timers.tick(250);
  for (let i=0;i<20;i++) await Promise.resolve();
  assert.equal(settled, true, 'the IPC promise must not hang after the recovered run');
  await result;
  const finished = await handlers.get('pi:session')({},'demo');
  assert.equal(finished.running, false); assert.equal(finished.requestId, undefined);
  assert.equal(unsubscribed, 1);
  assert.equal(sent.filter(event => event.payload?.type === 'done').length, 1);
});
