import test from 'node:test';
import assert from 'node:assert/strict';
import { localToolSelection, patternMatches, sameToolNames, toggleToolSelection, selectionFromSources } from '../../web/src/features/tools/agent-tool-selection.ts';
import { groupAgentTools } from '../../web/src/features/tools/agent-tool-groups.ts';

test('the local editor preserves local rules and provenance while leaving server methods out of the draft', () => {
  const source = { source: 'npm:docs' };
  assert.deepEqual(localToolSelection({
    enabled: ['read', '*', 'docs_*', 'mcp__offline__*', 'mcp__docs__search'],
    sources: { 'docs_*': source, 'mcp__docs__search': { source: 'mcp:docs' } },
  }), { enabled: ['read', '*', 'docs_*'], sources: { 'docs_*': source } });
});

test('catalog groups follow capabilities and search finds localized tools and extension commands', () => {
  const core = key => ({ kind: 'core', label: 'Pi 核心', key, source: key, scope: 'builtin' });
  const extension = { kind: 'extension', scope: 'user', source: 'npm:release', label: '发布工具' };
  const catalog = {
    tools: [
      { name: 'read', description: 'Read file', source: core('builtin:durable-coding-tools') },
      { name: 'ls', source: core('builtin:studio-filesystem-tools') },
      { name: 'browser_open', source: core('builtin:studio-browser-tools') },
      { name: 'mcp__docs__search', source: extension },
      { name: 'external', source: { ...extension, kind: 'mcp' } },
    ],
    commands: [{ name: 'deploy', description: '发布新版本', source: extension }],
  };
  const all = groupAgentTools(catalog, '');
  assert.deepEqual(all.map(group => group.label), ['文件与终端', '浏览器', '发布工具']);
  assert.deepEqual(all[0].tools.map(tool => tool.name), ['read', 'ls']);
  assert.deepEqual(groupAgentTools(catalog, '读取')[0].tools.map(tool => tool.name), ['read']);
  assert.equal(groupAgentTools(catalog, ' /DEPLOY ')[0].commands[0].name, 'deploy');
  assert.deepEqual(groupAgentTools(catalog, 'mcp__'), []);
});

test('built-in list, detail and search use Chinese copy even for an English runtime catalog', () => {
  const source = { kind: 'core', scope: 'builtin', key: 'builtin:studio-desktop-control', label: '电脑操控' };
  const description = 'List running macOS applications and whether each one is allowed for desktop observation.';
  const thirdParty = { kind: 'extension', scope: 'user', key: 'user:demo', source: 'user:demo', label: '演示扩展' };
  const catalog = {
    tools: [
      { name: 'desktop_apps', description, source },
      { name: 'desktop_apps', description: 'Enumerate game controllers.', source: thirdParty },
      { name: 'read', description: '读取手柄的摇杆位置。', source: thirdParty },
    ],
    commands: [{ name: 'calibrate', description: 'Calibrate game controllers.', source: thirdParty }],
  };
  const desktop = groupAgentTools(catalog, '正在运行的应用')[0].tools[0];
  assert.match(desktop.description, /哪些应用已获准观察/);
  assert.equal(desktop.originalDescription, undefined);
  assert.deepEqual(groupAgentTools(catalog, 'running macOS')[0].tools[0], desktop);
  const extension = groupAgentTools(catalog, 'game controllers')[0];
  assert.match(extension.tools[0].description, /中文说明/);
  assert.equal(extension.tools[0].originalDescription, 'Enumerate game controllers.');
  assert.equal(extension.commands[0].originalDescription, 'Calibrate game controllers.');
  assert.equal(groupAgentTools(catalog, '摇杆')[0].tools[0].description, '读取手柄的摇杆位置。');
});

test('tool patterns match literal punctuation and arbitrary wildcard positions', () => {
  assert.equal(patternMatches('mcp__docs__*', 'mcp__docs__search'), true);
  assert.equal(patternMatches('tool.v1', 'toolXv1'), false);
  assert.equal(patternMatches('a.*.z', 'a.x.z'), true);
  assert.equal(patternMatches('a.*.z', 'aXxXz'), false);
});

test('disabling wildcard member preserves known siblings and unrelated unresolved rules without duplicate entries', () => {
  const next = toggleToolSelection(['*', 'read', 'mcp__*', 'future_tool'], ['read', 'write', 'mcp__docs', 'mcp__docs'], 'read', false);
  assert.deepEqual(next, ['mcp__*', 'future_tool', 'write', 'mcp__docs']);
  assert.equal(next.some(rule => patternMatches(rule, 'read')), false);
  assert.equal(next.some(rule => patternMatches(rule, 'new_core_tool')), false);
});

test('allowing an already covered tool keeps the wildcard and disabling explicit entries leaves unrelated patterns', () => {
  assert.deepEqual(toggleToolSelection(['mcp__*'], [], 'mcp__docs', true), ['mcp__*']);
  assert.deepEqual(toggleToolSelection(['read', 'mcp__*'], [], 'read', false), ['mcp__*']);
});

test('recommended reset detection is order independent and rejects duplicate names', () => {
  assert.equal(sameToolNames(['write', 'read'], ['read', 'write']), true);
  assert.equal(sameToolNames(['read', 'read'], ['read', 'write']), false);
  assert.equal(sameToolNames(['read'], ['read', 'write']), false);
});

test('missing sources survive catalog refresh; removed names do not retain stale metadata', () => {
  const source = { source: 'extension:test', label: 'Test', scope: 'project', path: 'tool', baseDir: 'ext' };
  const previous = { enabled: ['missing', 'removed'], sources: { missing: source, removed: source } };
  const next = selectionFromSources(['missing', 'new'], {}, previous);
  assert.deepEqual(next.sources.missing, source);
  assert.equal(next.sources.removed, undefined);
  assert.equal(next.sources.new.source, 'manual');
});
