import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const conversationCss = fs.readFileSync(new URL('../../web/src/styles/app/02-conversation.css', import.meta.url), 'utf8');

function compile(path, stubs) {
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = {
    exports: {},
    require(id) {
      if (id.endsWith('.css')) return {};
      if (id in stubs) return stubs[id];
      return require(id);
    },
  };
  vm.runInNewContext(compiled, context);
  return context.exports;
}

const icons = new Proxy({}, { get: () => () => null });
const shellLayout = compile('../../web/src/shell/ShellLayout.tsx', {
  './ToolPanelLauncher': { ToolPanelAnchor: () => null },
  'lucide-react': icons,
  '../shared/HintButton': compile('../../web/src/shared/HintButton.tsx', {}),
  './app-shell-config': { BrandMark: () => null },
  '../shared/surface-visibility': compile('../../web/src/shared/surface-visibility.ts', {}),
});
function renderHeader({ isNewConversation = false, tabs } = {}) {
  const { ConversationHeader } = compile('../../web/src/shell/ConversationHeader.tsx', {
    react: React,
    'lucide-react': icons,
    '../shared/LoadingState': { LoadingIndicator: () => null },
    './ShellLayout': shellLayout,
  });
  return renderToStaticMarkup(React.createElement(ConversationHeader, {
    sidebarCollapsed: false,
    onExpandSidebar() {},
    isNewConversation,
    title: '会话',
    tabs,
  }));
}

test('conversation header keeps session tabs and leaves inspection to the conversation', () => {
  const tabs = React.createElement('nav', { 'aria-label': '当前会话标签' });
  const active = renderHeader({ tabs });
  assert.doesNotMatch(active, /会话检视|会话详情/);
  assert.match(active, /aria-label="当前会话标签"/);
  assert.doesNotMatch(active, /aria-label="扩展"/);
  assert.doesNotMatch(active, /notification-trigger|aria-label="通知"/);
});

test('draft conversations omit the session inspector', () => {
  const draft = renderHeader({ isNewConversation: true });
  assert.doesNotMatch(draft, /aria-label="(?:会话检视|进展|轨迹|扩展)"/);
});

test('the workspace toggle targets the mounted sidebar in its expanded state', () => {
  const render = expanded => renderToStaticMarkup(React.createElement(shellLayout.WorkspacePanelToggle, { expanded }));
  const closed = render(false);
  assert.match(closed, /aria-label="打开右侧面板"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /aria-controls=/);
  const open = render(true);
  assert.match(open, /aria-label="收起右侧面板"/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /aria-controls="workspace-side-panel"/);
});

test('the trace search box owns the focus ring instead of nesting two frames', () => {
  assert.match(conversationCss, /\.conversation-trace-search input:focus\s*\{[^}]*box-shadow:\s*none\s*!important/, 'inner input never paints its own ring');
  assert.match(conversationCss, /\.conversation-trace-search:focus-within\s*\{[^}]*border-color:\s*var\(--focus-color\);\s*box-shadow:\s*none/, 'wrapper highlights its existing border');
  assert.match(conversationCss, /\.conversation-trace-search:focus-within\s*\{[^}]*outline:\s*none/, 'wrapper drops the extra outline');
});
