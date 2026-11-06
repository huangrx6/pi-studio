import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { restoreTerminalReplay } from '../../web/src/features/terminal/terminal-replay.ts';

const replay = data => ({ cols: 80, rows: 24, steps: [{ type: 'data', data }], truncated: false });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

// Execute the actual component with controlled IPC, xterm and browser lifetimes.
// PTY process ownership remains covered by tests/electron/terminal-sessions.
function harness() {
  let cursor = 0, deps, effect, cleanup, dirty = false, tree, frameId = 0;
  const slots = [], frames = new Map(), listeners = new Map(), events = new Set();
  const creates = [], resizes = [], writes = [], terms = [], fits = [], observers = [], fonts = [];
  const host = { isConnected: true, clientWidth: 600, clientHeight: 400, contains: target => target === host };
  const document = {
    hidden: false, documentElement: {}, hasFocus: () => true,
    fonts: { load() { const pending = deferred(); fonts.push(pending); return pending.promise; } },
    addEventListener(type, fn) { const set = listeners.get(type) ?? new Set(); set.add(fn); listeners.set(type, set); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
  };
  const react = {
    useState(initial) {
      const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { const next = typeof value === 'function' ? value(slots[index]) : value; if (!Object.is(next, slots[index])) dirty = true; slots[index] = next; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(next, nextDeps) { if (!deps || nextDeps.some((value, index) => value !== deps[index])) { deps = nextDeps; effect = next; } },
  };
  class Terminal {
    constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.output = []; this.focuses = 0; this.refreshes = 0; terms.push(this); }
    loadAddon(fit) { fit.term = this; }
    open() {}
    write(data, callback) { assert.equal(this.disposed, undefined); if (data) { this.output.push(data); (this.writeSizes ??= []).push([this.cols, this.rows]); } if (this.holdWrites && callback) (this.callbacks ??= []).push(callback); else callback?.(); }
    resize(cols, rows) { this.cols = cols; this.rows = rows; }
    reset() { this.output = []; }
    refresh() { assert.equal(this.disposed, undefined); this.refreshes++; }
    focus() { this.focuses++; }
    onData(fn) { this.input = fn; return { dispose: () => { this.inputDisposed = true; } }; }
    dispose() { this.disposed = true; }
  }
  class FitAddon {
    constructor() { this.calls = 0; fits.push(this); }
    fit() { this.calls++; this.term.cols = Math.floor(host.clientWidth / 10); this.term.rows = Math.floor(host.clientHeight / 20); }
  }
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const api = {
    terminalCreate(payload) { const pending = deferred(); creates.push({ ...pending, payload }); return pending.promise; },
    terminalResize(...args) { resizes.push(args); return Promise.resolve(); },
    terminalWrite(...args) { writes.push(args); return Promise.resolve(); },
    terminalClose() { assert.fail('renderer mounts must never kill a user PTY'); },
    onTerminalEvent(fn) { events.add(fn); return () => events.delete(fn); },
  };
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  const source = fs.readFileSync(new URL('../../web/src/features/terminal/TerminalPanel.tsx', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, document, window: { piApi: api }, ResizeObserver: Observer, MutationObserver: Observer,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame(id) { frames.delete(id); },
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === '@xterm/xterm') return { Terminal };
      if (name === '@xterm/addon-fit') return { FitAddon };
      if (name.endsWith('error-text')) return { errorText: error => error.message };
      if (name.endsWith('terminal-replay')) return { restoreTerminalReplay };
      return {};
    },
  });
  const nodes = (node) => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
  let props = { id: 'a', cwd: '/workspace/a', onNewTerminal() {} };
  function render(next) {
    props = { ...props, ...next };
    do {
      dirty = false; cursor = 0; tree = module.exports.TerminalPanel(props);
      nodes(tree).find(node => node.props?.className === 'terminal-host').props.ref.current = host;
      if (effect) { cleanup?.(); cleanup = effect(); effect = null; }
    } while (dirty);
  }
  render();
  return {
    creates, resizes, writes, terms, fits, observers, fonts, document, host, frames, events, render,
    emit(event) { for (const fn of events) fn(event); },
    browser(type, event = { target: {} }) { for (const fn of [...(listeners.get(type) ?? [])]) fn(event); },
    tick() { const next = [...frames.values()]; frames.clear(); next.forEach(fn => fn()); },
    button(label) { return nodes(tree).find(node => node.type === 'button' && node.props['aria-label'] === label); },
    text() { return JSON.stringify(tree); },
    unmount() { cleanup?.(); },
    listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
    resolve(index = 0, extra = {}) { creates[index].resolve({ id: creates[index].payload.id, cwd: '/workspace/a', shell: 'zsh', status: 'running', sequence: 0, ...extra }); },
  };
}

test('creation waits before resizing, then synchronizes latest dimensions without repeated IPC', async () => {
  const h = harness(); assert.match(h.text(), /连接中/); assert.equal(h.resizes.length, 0);
  h.host.clientWidth = 900; h.observers[0].callback(); h.tick();
  assert.equal(h.resizes.length, 0);
  h.resolve(); await settle(); h.render(); h.tick();
  assert.deepEqual(h.resizes, [['a', 90, 20]]); assert.match(h.text(), /运行中/);
  h.observers[0].callback(); h.tick(); assert.equal(h.resizes.length, 1);
});

test('a newly created terminal restores its initial PTY dimensions before draining in-flight output', async () => {
  const h = harness(); const initial = h.creates[0].payload;
  h.host.clientWidth = 1000; h.observers[0].callback(); h.tick();
  assert.equal(h.terms[0].cols, 100); assert.equal(h.resizes.length, 0);
  h.emit({ id: 'a', type: 'data', sequence: 1, data: 'output at initial PTY width' });
  h.resolve(0, { createdNow: true, replay: { cols: initial.cols, rows: initial.rows, steps: [], truncated: false } });
  await settle();
  assert.deepEqual(h.terms[0].writeSizes, [[initial.cols, initial.rows]]);
  h.tick(); assert.equal(h.terms[0].cols, 100); assert.deepEqual(h.resizes.at(-1), ['a', 100, 20]);
  h.unmount();
});

test('snapshot and pending/live output preserve order and ignore other terminals and replay duplicates', async () => {
  const h = harness();
  h.emit({ id: 'a', type: 'data', sequence: 1, data: 'old' });
  h.emit({ id: 'b', type: 'data', sequence: 99, data: 'other' });
  h.emit({ id: 'a', type: 'data', sequence: 2, data: 'new' });
  h.emit({ id: 'a', type: 'exit', status: 'exited', exitCode: 7 });
  h.resolve(0, { sequence: 1, replay: replay('snapshot') }); await settle(); h.render();
  h.emit({ id: 'a', type: 'data', sequence: 2, data: 'duplicate' });
  assert.deepEqual(h.terms[0].output, ['snapshot', 'new']); assert.match(h.text(), /已退出 · 7/);
});

test('hidden windows defer appearance and fits but keep output; visible recovery does not steal focus', async () => {
  const h = harness(); h.document.hidden = true; h.browser('visibilitychange');
  h.observers[0].callback(); h.observers[1].callback(); h.fonts[0].resolve(); await settle();
  const fitCalls = h.fits[0].calls;
  h.resolve(); await settle(); h.emit({ id: 'a', type: 'data', sequence: 1, data: 'hidden output' });
  assert.equal(h.frames.size, 0); assert.equal(h.terms[0].refreshes, 0); assert.equal(h.terms[0].focuses, 0);
  assert.deepEqual(h.terms[0].output, ['hidden output']);
  h.document.hidden = false; h.browser('visibilitychange'); h.tick();
  assert.equal(h.fits[0].calls, fitCalls + 1); assert.equal(h.terms[0].refreshes, 1); assert.equal(h.terms[0].focuses, 0);
});

test('user interaction during attachment prevents late autofocus, untouched opening still focuses', async () => {
  for (const type of ['focusin', 'pointerdown', 'keydown']) {
    const h = harness(); h.browser(type); h.resolve(); await settle();
    assert.equal(h.terms[0].focuses, 0); h.unmount();
  }
  const h = harness(); h.resolve(); await settle(); assert.equal(h.terms[0].focuses, 1);
});

test('header reconnect clears failure and obsolete requests cannot mutate a replacement terminal', async () => {
  const h = harness(); h.creates[0].reject(new Error('offline')); await settle(); h.render();
  assert.match(h.text(), /offline/);
  h.button('重新连接终端').props.onClick(); h.render(); assert.doesNotMatch(h.text(), /offline/);
  assert.equal(h.terms[0].disposed, true); assert.equal(h.events.size, 1);
  h.render({ id: 'b', cwd: '/workspace/b' });
  h.resolve(1, { replay: replay('late A') }); await settle();
  assert.deepEqual(h.terms[2].output, []); assert.equal(h.terms[1].focuses, 0);
  h.resolve(2, { replay: replay('B') }); await settle(); h.render(); assert.deepEqual(h.terms[2].output, ['B']);
});

test('unmount releases all renderer resources; late create/font/events cannot write, resize, or kill PTYs', async () => {
  const h = harness(); const lateEvent = [...h.events][0];
  h.observers[0].callback(); assert.equal(h.frames.size, 1);
  h.unmount(); h.resolve(); h.fonts[0].resolve(); await settle();
  lateEvent({ id: 'a', type: 'data', sequence: 1, data: 'late' }); h.terms[0].input('late input');
  assert.equal(h.events.size, 0); assert.equal(h.frames.size, 0); assert.equal(h.listenerCount(), 0);
  assert.ok(h.observers.every(observer => observer.disconnected)); assert.equal(h.terms[0].inputDisposed, true);
  assert.equal(h.terms[0].disposed, true); assert.deepEqual(h.terms[0].output, []);
  assert.equal(h.resizes.length, 0); assert.equal(h.writes.length, 0); assert.equal(h.terms[0].focuses, 0);
});

test('attachment overflow covered by the snapshot keeps the complete remaining event sequence', async () => {
  const h = harness();
  for (let sequence = 1; sequence <= 300; sequence++) h.emit({ id: 'a', type: 'data', sequence, data: String(sequence) });
  h.resolve(0, { sequence: 100, replay: replay('snapshot through 100') }); await settle(); h.render();
  assert.equal(h.terms[0].output[0], 'snapshot through 100');
  assert.deepEqual(h.terms[0].output.slice(1), Array.from({ length: 200 }, (_, index) => String(index + 101)));
  assert.doesNotMatch(h.text(), /同步中断/); h.unmount();
});

test('uncovered attachment overflow offers retry instead of silently dropping ANSI fragments', async () => {
  for (const overflow of ['events', 'chars']) {
    const h = harness();
    if (overflow === 'events') {
      for (let sequence = 1; sequence <= 300; sequence++) h.emit({ id: 'a', type: 'data', sequence, data: String(sequence) });
    } else {
      h.emit({ id: 'a', type: 'data', sequence: 1, data: 'x'.repeat(1_000_001) });
      h.emit({ id: 'a', type: 'data', sequence: 2, data: 'tail' });
    }
    h.resolve(); await settle(); h.render();
    assert.match(h.text(), /同步中断/); assert.deepEqual(h.terms[0].output, []);
    h.terms[0].input('must not enter a corrupted screen');
    assert.equal(h.writes.length, 0); assert.equal(h.terms[0].focuses, 0);
    h.button('重新连接终端').props.onClick(); h.render();
    h.resolve(1, { sequence: 300, replay: replay('latest snapshot') }); await settle(); h.render();
    h.emit({ id: 'a', type: 'data', sequence: 301, data: 'continued' });
    assert.deepEqual(h.terms[1].output, ['latest snapshot', 'continued']);
    assert.doesNotMatch(h.text(), /同步中断/); h.unmount();
  }
});

test('live sequence gap stops parser input and further writes until a fresh connection', async () => {
  const h = harness(); h.resolve(); await settle();
  h.emit({ id: 'a', type: 'data', sequence: 1, data: 'intact' });
  h.emit({ id: 'a', type: 'data', sequence: 3, data: 'missing CSI prefix' }); h.render();
  h.emit({ id: 'a', type: 'data', sequence: 4, data: 'later' }); h.terms[0].input('ignored');
  assert.deepEqual(h.terms[0].output, ['intact']); assert.match(h.text(), /同步中断/);
  assert.equal(h.writes.length, 0); h.unmount();
});

test('observers cannot change geometry during replay and pending output follows fully parsed history', async () => {
  const h = harness(); const term = h.terms[0]; term.holdWrites = true;
  h.resolve(0, { sequence: 2, replay: {
    cols: 36, rows: 39, truncated: true,
    steps: [{ type: 'data', data: 'narrow' }, { type: 'resize', cols: 55, rows: 33 }, { type: 'data', data: 'wide' }],
  } }); await settle();
  assert.equal(term.cols, 36);
  h.host.clientWidth = 1000; h.observers[0].callback(); h.tick();
  assert.equal(term.cols, 36); assert.equal(h.resizes.length, 0);
  h.emit({ id: 'a', type: 'data', sequence: 3, data: 'live' });
  term.callbacks.shift()(); await settle(); assert.equal(term.cols, 55);
  assert.deepEqual(term.output, ['narrow', 'wide']);
  term.callbacks.shift()(); await settle(); h.render();
  assert.deepEqual(term.output, ['narrow', 'wide', 'live']);
  assert.match(h.text(), /较早输出已清理/);
  h.tick(); assert.equal(term.cols, 55);
  term.callbacks.shift()(); assert.equal(term.cols, 100); assert.deepEqual(h.resizes.at(-1), ['a', 100, 20]);
  h.unmount();
});

test('queue overflow during slow replay is detected after the snapshot finishes parsing', async () => {
  const h = harness(); const term = h.terms[0]; term.holdWrites = true;
  h.resolve(0, { sequence: 1, replay: replay('snapshot') }); await settle();
  for (let sequence = 2; sequence <= 300; sequence++) h.emit({ id: 'a', type: 'data', sequence, data: 'late' });
  term.callbacks.shift()(); await settle(); h.render();
  assert.match(h.text(), /同步中断/); assert.deepEqual(term.output, ['snapshot']);
  assert.equal(term.focuses, 0); h.unmount();
});

test('output arriving behind a resize barrier is parsed before the size changes', async () => {
  const h = harness(); h.resolve(); await settle(); h.tick();
  const term = h.terms[0]; term.holdWrites = true;
  const before = h.resizes.length;
  h.host.clientWidth = 1000; h.observers[0].callback(); h.tick();
  h.emit({ id: 'a', type: 'data', sequence: 1, data: 'received before resize' });
  term.callbacks.shift()();
  assert.equal(term.cols, 60); assert.equal(h.resizes.length, before);
  assert.equal(term.callbacks.length, 1, 'a new barrier follows the new data');
  term.callbacks.shift()();
  assert.equal(term.cols, 100); assert.equal(h.resizes.length, before + 1);
  h.unmount();
});
