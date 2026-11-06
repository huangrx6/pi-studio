import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as shortcuts from '../../web/src/shared/shortcuts.mjs';

// Drive the real component's effect and handlers. Native focus movement remains
// a browser QA responsibility; these tests verify it is never prevented.
function harness() {
  const slots = [], listeners = new Map(), writes = [];
  let cursor = 0, cleanup, effect, deps, tree;
  const jsx = (type, props) => ({ type, props });
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useId() { return `id-${cursor++}`; },
    useEffect(next, nextDeps) {
      if (!deps || nextDeps.some((value, index) => value !== deps[index])) { effect = next; deps = nextDeps; }
    },
  };
  const window = {
    addEventListener(type, fn) { const set = listeners.get(type) ?? new Set(); set.add(fn); listeners.set(type, set); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
  };
  const module = { exports: {} };
  const source = fs.readFileSync(new URL('../../web/src/shell/ShortcutSettings.tsx', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    window, module, exports: module.exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name.endsWith('shortcuts.mjs')) return {
        ...shortcuts,
        comboFromEvent: event => shortcuts.comboFromEvent(event, 'other'),
        formatShortcut: combo => shortcuts.formatShortcut(combo, false),
      };
      return {};
    },
  });
  const preferences = { shortcuts: { ...shortcuts.DEFAULT_SHORTCUTS } };
  const onChange = (key, value) => { writes.push(value); preferences[key] = value; };
  const all = (node, predicate) => !node || typeof node !== 'object' ? [] : [
    ...(predicate(node) ? [node] : []),
    ...[node.props?.children].flat(Infinity).flatMap(child => all(child, predicate)),
  ];
  function render() {
    cursor = 0;
    tree = module.exports.ShortcutSettings({ preferences, onChange });
    if (effect) { cleanup?.(); cleanup = effect(); effect = null; }
  }
  const button = (label = '命令面板') => all(tree, node => node.type === 'button' && node.props['aria-label']?.startsWith(`${label}：`))[0];
  const emit = (type, event = {}) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(event); };
  render();
  return {
    writes, render, button, emit,
    start(label) {
      const target = { contains: node => node === target };
      button(label).props.onClick({ currentTarget: target }); render();
      return target;
    },
    key(key, extra = {}) {
      const event = { key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
      emit('keydown', event); render(); return event;
    },
    status() { return all(tree, node => node.props?.role === 'status')[0].props.children; },
    unmount() { cleanup?.(); },
    listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
  };
}

test('Tab and Shift+Tab cancel without preventing native navigation; Escape cancels', () => {
  const h = harness();
  for (const extra of [{}, { shiftKey: true }]) {
    h.start(); const event = h.key('Tab', extra);
    assert.equal(event.prevented, false); assert.equal(event.stopped, true);
    assert.equal(h.button().props['aria-pressed'], false);
  }
  h.start(); assert.equal(h.key('Escape').prevented, true);
  assert.equal(h.writes.length, 0); assert.match(h.status(), /取消/);
  assert.equal(h.listenerCount(), 0);
});

test('IME events remain native and cannot record or cancel; valid combos suppress global dispatch', () => {
  const h = harness(); h.start();
  for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = h.key('Escape', extra);
    assert.equal(event.prevented, false); assert.equal(event.stopped, false);
    assert.equal(h.button().props['aria-pressed'], true);
  }
  const event = h.key('g', { ctrlKey: true });
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  assert.equal(h.writes[0].palette, 'Mod+G'); assert.match(h.status(), /已将/);
});

test('conflicting and bare keys preserve bindings; modifiers and repeated keys do not save', () => {
  const h = harness(); h.start();
  h.key('j', { ctrlKey: true }); assert.match(h.status(), /已被/);
  h.key('g'); assert.match(h.status(), /有效组合/);
  h.key('Control', { ctrlKey: true });
  h.key('g', { ctrlKey: true, repeat: true });
  assert.equal(h.writes.length, 0); assert.equal(h.button().props['aria-pressed'], true);
  h.key('g', { ctrlKey: true }); assert.equal(h.writes.length, 1);
});

test('outside pointer, focus changes, button blur, window blur and unmount stop recording', () => {
  const h = harness();
  const owner = h.start(); h.emit('pointerdown', { target: owner }); h.render();
  assert.equal(h.button().props['aria-pressed'], true);
  for (const type of ['pointerdown', 'focusin', 'blur']) {
    h.emit(type, { target: {} }); h.render();
    assert.equal(h.button().props['aria-pressed'], false);
    h.start();
  }
  h.button().props.onBlur();
  // Before React commits cancellation, the old listener must not write either.
  h.key('g', { ctrlKey: true }); assert.equal(h.writes.length, 0);
  h.start(); h.unmount(); assert.equal(h.listenerCount(), 0);
});

test('two synchronous key events save once before React effect cleanup', () => {
  const h = harness(); h.start();
  const event = key => ({ key, ctrlKey: true, preventDefault() {}, stopImmediatePropagation() {} });
  h.emit('keydown', event('g')); h.emit('keydown', event('h'));
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].palette, 'Mod+G');
});
