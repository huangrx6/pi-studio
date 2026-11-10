import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(
  new URL('../../web/src/features/conversation/QueuedMessages.tsx', import.meta.url),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const icons = {
  ArrowUp: () => null,
  ChevronDown: () => null,
  Clock3: () => null,
  GripVertical: () => null,
  Pencil: () => null,
  Trash2: () => null,
};

/** 用给定的 React 实现加载组件：SSR 用真 React，展开态用把 expanded 置 true 的替身。 */
function load(react) {
  const context = { exports: {} };
  vm.runInNewContext(compiled, {
    ...context,
    require(id) {
      if (id === 'react') return react;
      if (id === 'lucide-react') return icons;
      return require(id);
    },
  });
  return context.exports.QueuedMessages;
}

const Collapsed = load(React);
// 组件里两个 useState 依次是拖动中的 id（null）和是否展开（false）。
const expandedReact = {
  ...React,
  useState(initial) { return [initial === false ? true : initial, () => {}]; },
};
const Expanded = load(expandedReact);

const item = (id, text, extra = {}) => ({
  id,
  text,
  images: 0,
  files: 0,
  ...extra,
});

function render(items, overrides = {}) {
  return renderToStaticMarkup(React.createElement(Collapsed, {
    items,
    canSteer: false,
    onEdit() {},
    onDelete() {},
    onSendNow() {},
    onSendAll() {},
    onReorder() {},
    ...overrides,
  }));
}

function renderExpanded(items, overrides = {}) {
  return renderToStaticMarkup(React.createElement(Expanded, {
    items,
    canSteer: false,
    onEdit() {},
    onDelete() {},
    onSendNow() {},
    onSendAll() {},
    onReorder() {},
    ...overrides,
  }));
}

function row(html, text) {
  return html
    .split('<div class="queued-item')
    .slice(1)
    .map(markup => `<div class="queued-item${markup.slice(0, markup.indexOf('</div>') + 6)}`)
    .find(markup => markup.includes(text))
    ?? '';
}

test('the queue stays a single summary row until it is expanded', () => {
  const items = [item('one', 'one'), item('two', 'two')];
  const collapsed = render(items);
  assert.match(collapsed, /aria-expanded="false"/);
  assert.match(collapsed, />消息</);
  assert.match(collapsed, /queued-panel-meta/);
  assert.doesNotMatch(collapsed, /queued-item/);
  assert.doesNotMatch(collapsed, /发送全部/);

  const expanded = renderExpanded(items);
  assert.match(expanded, /aria-expanded="true"/);
  assert.equal((expanded.match(/class="queued-item /g) ?? []).length, 2);
  assert.match(expanded, /class="queued-footer"/);
});

test('only the request awaiting Durable admission locks its row and explains why', () => {
  const html = renderExpanded([
    item('pending', 'pending message', { admissionPending: true }),
    item('ready', 'ready message'),
  ]);
  const pending = row(html, 'pending message');
  const ready = row(html, 'ready message');

  assert.match(pending, /aria-busy="true"/);
  assert.match(pending, /正在确认消息是否已发送…/);
  assert.match(pending, /<button type="button" disabled=""/g);
  assert.equal((pending.match(/<button type="button" disabled=""/g) ?? []).length, 3);
  assert.doesNotMatch(pending, /draggable="true"/);

  assert.doesNotMatch(ready, /aria-busy="/);
  assert.equal((ready.match(/<button type="button" disabled=""/g) ?? []).length, 0);
  assert.match(ready, /draggable="true"/);
});

test('global send guards disable sending without blocking safe edits to other rows', () => {
  const html = renderExpanded([item('ready', 'ready message')], { sendDisabled: true });
  const ready = row(html, 'ready message');
  assert.equal((ready.match(/<button type="button" disabled=""/g) ?? []).length, 1);
  assert.match(html, /<button type="button" class="queued-send-all" disabled=""/);
});

test('idle queue actions use ordinary sending labels while running turns use steering labels', () => {
  const idle = renderExpanded([item('one', 'one')], { canSteer: false });
  const running = renderExpanded([item('one', 'one')], { canSteer: true });
  assert.match(idle, />发送全部<\/button>/);
  assert.match(idle, /aria-label="立即发送"/);
  assert.match(running, />插话发送全部<\/button>/);
  assert.match(running, /aria-label="立即插话发送"/);
});
