import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = [
  fs.readFileSync(new URL('../../web/src/shell/SettingsOverlay.tsx', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('../../web/src/shell/useSettingsWorkspace.ts', import.meta.url), 'utf8'),
].join('\n');
const ast = ts.createSourceFile('skill-commit-notice.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback, effect;
function visit(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'SkillHub') {
    callback = node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(ast) === 'onCommitted')?.initializer.expression.getText(ast);
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[1]?.getText(ast) === '[workspace]' && node.arguments[0]?.getText(ast).includes('setResourceWriteBusy')) effect = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast); assert.ok(callback); assert.ok(effect);
const code = ts.transpileModule(`globalThis.committed = ${callback};\nglobalThis.scopeEffect = ${effect};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const notices = [], setterCalls = [];
  const h = {
    workspace: '/A', workspaceRef: { current: '/B' },
    invalidateResourceReads() { h.invalidations = (h.invalidations || 0) + 1; },
    reportSkillRefresh: (...args) => notices.push(args),
    controller: {
      invalidateResourceReads: () => h.invalidateResourceReads(),
      reportSkillRefresh: (...args) => h.reportSkillRefresh(...args),
    },
    resourceCommitRef: { current: null }, resourceWriteRef: { current: null },
    resourcePendingRef: { current: { models: true, mcp: true, skills: true } },
    skillRefreshTargetsRef: { current: new Set(['/A', '/other-project']) },
    providerCatalogRequestsRef: { current: new Map() }, providerDiscoveryRequestsRef: { current: new Map() },
  };
  for (const name of ['modelRefresh', 'mcpRefresh', 'skillRefresh', 'extensionRefresh']) {
    h[`${name}RequestRef`] = { current: 2 }; h[`${name}LockRef`] = { current: true };
  }
  for (const name of ['ModelRefreshBusy', 'McpRefreshBusy', 'SkillRefreshBusy', 'ResourceWriteBusy', 'ModelRefreshError', 'McpRefreshError', 'SkillRefreshError', 'ProviderModels', 'ProviderCatalogState', 'ProviderDiscovery', 'ExpandedProvider']) h[`set${name}`] = value => setterCalls.push([name, value]);
  vm.runInNewContext(code, h);
  return { h, notices, setterCalls };
}
const result = projection => ({ committed: true, installed: { name: 'fixture' }, projection });

test('late marketplace commit after a workspace change records its original target without applying its snapshot', () => {
  const { h, notices } = harness(); h.committed(result({ status: 'ready', value: { scope: '/A' } }), '/A');
  assert.equal(h.invalidations, 1); assert.deepEqual(notices, [['/A', '技能「fixture」已安装', '请刷新当前技能状态。']]);
});

test('current marketplace commit retains both failed and ready facts for an unmounted same-workspace skill tab', () => {
  const { h, notices } = harness(); h.workspaceRef.current = '/A';
  h.committed(result({ status: 'error', message: 'needs refresh' }), '/project-target');
  assert.equal(notices[0][0], '/project-target'); assert.equal(notices[0][2], 'needs refresh');
  h.committed(result({ status: 'ready', value: {} }), '/A'); assert.equal(notices.length, 2);
  assert.deepEqual(notices[1], ['/A', '技能「fixture」已安装', '请刷新当前技能状态。']);
});

test('workspace effect invalidates pending reads but retains all committed notices and skill target scopes', () => {
  const { h, setterCalls } = harness(), pending = h.resourcePendingRef.current;
  const cleanup = h.scopeEffect();
  assert.equal(h.resourcePendingRef.current, pending); assert.deepEqual(pending, { models: true, mcp: true, skills: true });
  assert.deepEqual([...h.skillRefreshTargetsRef.current], ['/A', '/other-project']);
  assert.equal(setterCalls.some(([name]) => name.endsWith('RefreshError')), false);
  for (const name of ['modelRefresh', 'mcpRefresh', 'skillRefresh']) { assert.equal(h[`${name}RequestRef`].current, 3); assert.equal(h[`${name}LockRef`].current, false); }
  cleanup(); for (const name of ['modelRefresh', 'mcpRefresh', 'skillRefresh']) assert.equal(h[`${name}RequestRef`].current, 4);
});
