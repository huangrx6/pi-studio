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
function compile(path, imports = {}) {
  const context = { exports: {}, setTimeout, clearTimeout, window: { piApi: {} }, require(id) {
    if (id.endsWith('.css')) return {};
    return imports[id] ?? require(id);
  } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.exports;
}
const helper = compile('../../web/src/features/extensions/extension-install-session.ts', { '../../shared/error-text': { errorText } });
const { ExtensionInstallDialog } = compile('../../web/src/features/extensions/ExtensionInstallDialog.tsx', {
  './extension-install-session': helper,
  '../../shared/InfoHint': { InfoHint: () => null },
  '../../shared/SettingsDialog': { SettingsDialog: ({ title, action, unavailable, children, footerHint }) => React.createElement('section', null,
    React.createElement('h2', null, title), children, footerHint && React.createElement('p', null, footerHint), React.createElement('button', { disabled: unavailable }, action)) },
});
const initialPreview = {
  token: 'qa', scope: 'project', id: 'qa.extension', name: 'QA extension', version: '2.0.0', publisher: 'QA author', description: 'Safe synthetic fixture',
  permissions: ['agent.tools', 'ui.panels'], addedPermissions: ['agent.tools'], providerAccess: ['existing-provider', 'new-provider'], addedProviderAccess: ['new-provider'],
  requires: ['existing-dependency', 'new-dependency'], addedRequirements: ['new-dependency'], missingDependencies: [],
  executable: true, executableExpansion: true, requiresPublisherTrust: true, publisherTrust: 'untrusted', signatureKeyId: 'complete-key-fingerprint-0123456789',
  sourceKind: 'github-commit', source: 'github:example/project@main', resolvedRef: 'full-fixed-commit-reference', treeSha256: 'complete-tree-sha256', archiveSha256: 'complete-archive-sha256',
  upgrade: true, installedVersion: '1.0.0',
};
const render = (preview = initialPreview) => renderToStaticMarkup(React.createElement(ExtensionInstallDialog, {
  cwd: '/synthetic/workspace', workspaceName: 'QA workspace', registryUrl: '', initialPreview: preview, onClose() {}, onInstalled() {},
}));

test('installation consent, source, execution boundary, dependencies and publisher fingerprint remain outside technical disclosure', () => {
  const html = render();
  const visible = html.replace(/<details[\s\S]*?<\/details>/g, '');
  for (const text of ['QA author', '当前工作区', 'github:example/project@main', 'full-fixed-commit-reference', '受信任的主进程 Node 代码',
    '向智能体提供工具', '添加界面面板', 'existing-provider', 'new-provider', 'existing-dependency', 'new-dependency',
    'complete-key-fingerprint-0123456789', '我了解并接受这些能力', '可执行能力发生变化']) assert.ok(visible.includes(text), text);
  assert.match(html, /<input type="checkbox"\/>/);
  assert.match(html, /<button disabled="">升级到 v2.0.0<\/button>/);
  assert.match(html, /撤销旧信任/);
});

test('technical identity and full integrity hashes remain accessible in a closed details element', () => {
  const html = render();
  assert.match(html, /<details class="extension-integrity"><summary>技术信息与完整性校验<\/summary>/);
  const technical = html.match(/<details[\s\S]*?<\/details>/)?.[0];
  for (const text of ['qa.extension', 'complete-tree-sha256', 'complete-archive-sha256']) assert.ok(technical.includes(text), text);
  assert.match(technical, /不代表发布者签名或身份认证/);
});

test('missing dependencies block submission and initial source mode uses ordinary accessible buttons', () => {
  const missing = render({ ...initialPreview, missingDependencies: ['new-dependency'] });
  assert.match(missing, /class="is-missing"/);
  assert.match(missing, /请先安装缺失依赖/);
  assert.match(missing, /<button disabled="">/);
  const source = render(null);
  assert.match(source, /role="group" aria-label="扩展安装来源"/);
  assert.doesNotMatch(source, /role="tab/);
  assert.match(source, /aria-label="选择扩展开发目录"/);
  assert.match(source, /aria-label="选择扩展安装包"/);
});
