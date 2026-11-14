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
function renderHeader(showTrace, isNewConversation = false, panelExpanded = false) {
  const { ConversationHeader } = compile('../../web/src/shell/ConversationHeader.tsx', {
    react: React,
    'lucide-react': icons,
    './NotificationCenter': { NotificationCenter: () => null },
    '../features/extensions/ExtensionChips': { ExtensionChips: () => null },
    './ConversationWorkspaceMenu': {
      ConversationWorkspaceMenu: ({ onOpenTrace }) => React.createElement(
        'div', { className: 'workspace-menu-trigger' },
        onOpenTrace && React.createElement('span', { className: 'fake-trace-tab' }, '轨迹'),
      ),
    },
    '../../types/extension-types': {},
  });
  return renderToStaticMarkup(React.createElement(ConversationHeader, {
    sidebarCollapsed: false,
    onExpandSidebar() {},
    isNewConversation,
    title: '会话',
    agentKind: 'conversation',
    subagentCount: 0,
    hasActiveSubagents: false,
    extensionCount: 0,
    notifications: [],
    onMarkAllRead() {},
    onClearNotifications() {},
    onOpenNotificationSession: async () => {},
    onRunNotificationAction: async () => {},
    panelExpanded,
    onOpenPanel() {},
    onReturnToMainAgent() {},
    onOpenAgentOverview() {},
    onOpenConversationExtensionHub() {},
    chips: [],
    extensionSurface: { items: [], errors: [], syncedAt: 0, apiVersion: 1 },
    onOpenChip() {},
    onOpenTrace() {},
    showTrace,
    traceSummary: { steps: 3, requests: 1, tools: 2, state: 'done', items: [], errors: 0 },
  }));
}

test('the trace tab only exists while the code work view setting is on', () => {
  assert.doesNotMatch(renderHeader(false), /fake-trace-tab/, 'disabled setting hides the trace tab');
  assert.match(renderHeader(true), /fake-trace-tab/, 'enabled setting shows the trace tab');
});

test('only existing conversations show the session workspace menu', () => {
  assert.doesNotMatch(renderHeader(true, true), /workspace-menu-trigger/);
  assert.match(renderHeader(true, false), /workspace-menu-trigger/);
});

test('draft and existing conversations can both open the right sidebar', () => {
  for (const isNewConversation of [true, false]) {
    const closed = renderHeader(false, isNewConversation);
    assert.match(closed, /panel-open-entry/);
    assert.doesNotMatch(closed, /<button[^>]*panel-open-entry[^>]*disabled/);
    assert.match(renderHeader(false, isNewConversation, true), /<button[^>]*panel-open-entry[^>]*aria-hidden="true"[^>]*disabled/);
  }
});

test('the trace search box owns the focus ring instead of nesting two frames', () => {
  assert.match(conversationCss, /\.conversation-trace-search input:focus\s*\{[^}]*box-shadow:\s*none\s*!important/, 'inner input never paints its own ring');
  assert.match(conversationCss, /\.conversation-trace-search:focus-within\s*\{[^}]*box-shadow:\s*var\(--focus-ring\)/, 'wrapper paints the single focus ring');
  assert.match(conversationCss, /\.conversation-trace-search:focus-within\s*\{[^}]*outline:\s*none/, 'wrapper drops the extra outline');
});
