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
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText, {
  ...context,
  require(id) {
    if (id === 'react') return React;
    if (id === 'lucide-react') {
      const Icon = () => null;
      return {
        ArrowUp: Icon,
        Clock3: Icon,
        GripVertical: Icon,
        Pencil: Icon,
        Trash2: Icon,
      };
    }
    return require(id);
  },
});
const { QueuedMessages } = context.exports;

const item = (id, text, extra = {}) => ({
  id,
  text,
  images: 0,
  files: 0,
  ...extra,
});

function render(items, overrides = {}) {
  return renderToStaticMarkup(React.createElement(QueuedMessages, {
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

test('only the request awaiting Durable admission locks its row and explains why', () => {
  const html = render([
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
  const html = render([item('ready', 'ready message')], { sendDisabled: true });
  const ready = row(html, 'ready message');
  assert.equal((ready.match(/<button type="button" disabled=""/g) ?? []).length, 1);
  assert.match(html, /<button type="button" class="queued-send-all" disabled=""/);
});

test('idle queue actions use ordinary sending labels while running turns use steering labels', () => {
  const idle = render([item('one', 'one')], { canSteer: false });
  const running = render([item('one', 'one')], { canSteer: true });
  assert.match(idle, />发送全部<\/button>/);
  assert.match(idle, /aria-label="立即发送"/);
  assert.match(running, />插话发送全部<\/button>/);
  assert.match(running, /aria-label="立即插话发送"/);
});
