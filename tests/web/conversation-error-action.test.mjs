import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { errorText } from '../../web/src/shared/error-text.ts';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../../web/src/features/conversation/ConversationError.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const context = {
  exports: {},
  require(id) {
    if (id.endsWith('.css')) return {};
    if (id.endsWith('/error-text')) return { errorText };
    if (id === './error-presentation') {
      return {
        conversationErrorPresentation: (message) => ({
          summary: message.split('\n')[0],
          details: message.includes('\n') ? message : null,
        }),
      };
    }
    if (id === 'lucide-react') return { X: () => React.createElement('span', null, 'x') };
    return require(id);
  },
};
vm.runInNewContext(compiled, context);
const { ConversationError } = context.exports;
const render = (props) => renderToStaticMarkup(React.createElement(ConversationError, props));

test('a recoverable conversation error exposes one explicit action and keeps retries bounded', () => {
  const idle = render({ message: '实时连接已断开。', actionLabel: '重新连接', onAction() {} });
  assert.match(idle, /role="alert"/);
  assert.match(idle, /实时连接已断开。/);
  assert.match(idle, /class="conversation-error-action"[^>]*>重新连接<\/button>/);
  assert.doesNotMatch(idle, /disabled|aria-busy/);

  const busy = render({ message: '实时连接已断开。', actionLabel: '重新连接', actionBusy: true, onAction() {} });
  assert.match(busy, /class="conversation-error-action" disabled="" aria-busy="true">正在连接…<\/button>/);
  assert.equal((busy.match(/class="conversation-error-action"/g) || []).length, 1);
});

test('ordinary dismiss-only errors do not gain a reconnect action', () => {
  const html = render({ message: '执行失败。', onDismiss() {} });
  assert.doesNotMatch(html, /conversation-error-action|重新连接/);
  assert.match(html, /aria-label="关闭错误提示"/);
});
