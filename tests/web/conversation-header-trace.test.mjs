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
const traceTab = ({ summary }) => React.createElement('span', { className: 'fake-trace-tab' }, `轨迹 ${summary?.steps ?? 0}`);

function renderHeader(showTrace) {
  const { ConversationHeader } = compile('../../web/src/shell/ConversationHeader.tsx', {
    react: React,
    'lucide-react': icons,
    './NotificationCenter': { NotificationCenter: () => null },
    './ConversationTraceMenu': { ConversationTraceTab: traceTab },
    '../features/extensions/ExtensionChips': { ExtensionChips: () => null },
    '../../types/extension-types': {},
  });
  return renderToStaticMarkup(React.createElement(ConversationHeader, {
    sidebarCollapsed: false,
    onExpandSidebar() {},
    isNewConversation: false,
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
    filesOpen: false,
    onTogglePanel() {},
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

test('the trace search box owns the focus ring instead of nesting two frames', () => {
  assert.match(conversationCss, /\.conversation-trace-search input:focus\s*\{[^}]*box-shadow:\s*none\s*!important/, 'inner input never paints its own ring');
  assert.match(conversationCss, /\.conversation-trace-search:focus-within\s*\{[^}]*box-shadow:\s*var\(--focus-ring\)/, 'wrapper paints the single focus ring');
  assert.match(conversationCss, /\.conversation-trace-search:focus-within\s*\{[^}]*outline:\s*none/, 'wrapper drops the extra outline');
});
