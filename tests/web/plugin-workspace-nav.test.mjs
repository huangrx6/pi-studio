import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const sourcePath = new URL('../../web/src/shell/app-shell-config.tsx', import.meta.url);

function loadConfig() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const context = {
    exports: {},
    module: { exports: {} },
    require(id) {
      if (id.endsWith('.png') || id.endsWith('.css')) return 'data:image/png;base64,';
      if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return require(id);
      if (id === 'react') return require('react');
      if (id === 'lucide-react') {
        return new Proxy({}, { get: () => () => null });
      }
      return require(id);
    },
  };
  context.module.exports = context.exports;
  vm.runInNewContext(compiled, context);
  return context.module.exports;
}

const mod = loadConfig();

test('settingsPages only keep plugins under 资源与扩展 primitives', () => {
  const ids = mod.settingsPages.map((page) => page.id);
  assert.ok(ids.includes('plugins'));
  assert.equal(ids.includes('extensions'), false);
  assert.equal(ids.includes('mcp'), false);
  assert.equal(ids.includes('skills'), false);
});

test('resolveSettingsDestination maps mcp/skills deep links into plugin hub and resets plugins entry to default tab', () => {
  const mcp = mod.resolveSettingsDestination('mcp');
  assert.equal(mcp.tab, 'plugins');
  assert.equal(mcp.pluginSection, 'mcp');
  const skills = mod.resolveSettingsDestination('skills');
  assert.equal(skills.tab, 'plugins');
  assert.equal(skills.pluginSection, 'skills');
  const extensions = mod.resolveSettingsDestination('extensions');
  assert.equal(extensions.tab, 'plugins');
  assert.equal(extensions.pluginSection, 'extensions');
  const plugins = mod.resolveSettingsDestination('plugins');
  assert.equal(plugins.tab, 'plugins');
  assert.equal(plugins.pluginSection, 'plugins');
  const general = mod.resolveSettingsDestination('general');
  assert.equal(general.tab, 'general');
  assert.equal(general.pluginSection, undefined);
});

test('isPluginWorkspaceTab covers hub destinations', () => {
  assert.equal(mod.isPluginWorkspaceTab('plugins'), true);
  assert.equal(mod.isPluginWorkspaceTab('mcp'), true);
  assert.equal(mod.isPluginWorkspaceTab('skills'), true);
  assert.equal(mod.isPluginWorkspaceTab('extensions'), true);
  assert.equal(mod.isPluginWorkspaceTab('models'), false);
});

test('closing settings or leaving a page resets plugin tabs and transient model views', async () => {
  const settingsSource = fs.readFileSync(new URL('../../web/src/shell/useAppSettings.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('useAppSettings.ts', settingsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set([
    'resetTransientSettingsUi',
    'applySettingsDestination',
    'selectSettingsTab',
    'selectPluginSection',
    'selectAgentSection',
    'closeSettings',
    'openSettings',
  ]);
  const functions = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) functions.push(node.getText(tree));
    else ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(functions.length, names.size);
  const code = ts.transpileModule(
    `${functions.join('\n')}\nObject.assign(globalThis, {${[...names].join(',')}});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;

  let skillClosed = 0;
  let mcpClosed = 0;
  const h = {
    resolveSettingsDestination: mod.resolveSettingsDestination,
    settingsOpen: false,
    settingsTab: 'general',
    settingsAnchor: undefined,
    pluginSection: 'plugins',
    agentSection: 'main',
    modelView: 'all',
    modelQuery: '',
    expandedProvider: null,
    providerDiscovery: {},
    extensionDetail: null,
    extensionInstallerOpen: false,
    extensionInstallPreview: null,
    settingsReturnFocusRef: { current: null },
    settingsRequestRef: { current: 0 },
    providerDiscoveryRequestsRef: { current: new Map([['openai', 1]]) },
    modelRevisionRef: { current: new Map() },
    modelWritesRef: { current: new Set() },
    sessionLoadRef: { current: 0 },
    sessionRef: { current: null },
    defaultModelWorkspaceRef: { current: '/A' },
    workspace: '/A',
    workspaceRef: { current: '/A' },
    document: { activeElement: null },
    canLeaveSettings: async () => true,
    closeSkillDetail: () => { skillClosed += 1; },
    closeMcpDetail: () => { mcpClosed += 1; },
    errorText: (error) => String(error),
    window: {
      piApi: {
        settings: async () => ({ providers: [], mcp: [], skills: [], extensions: [] }),
        models: async () => ({ models: [], enabled: [], selection: { modelRef: '' }, defaultSelection: { modelRef: '' } }),
      },
    },
  };
  for (const field of [
    'SettingsOpen', 'SettingsTab', 'SettingsAnchor', 'PluginSection', 'AgentSection',
    'ModelView', 'ModelQuery', 'ExpandedProvider', 'ProviderDiscovery',
    'ExtensionDetail', 'ExtensionInstallerOpen', 'ExtensionInstallPreview',
    'SettingsError', 'SettingsData', 'Models', 'EnabledModels',
    'DefaultModelSelection', 'ModelSelection',
  ]) {
    const key = field[0].toLowerCase() + field.slice(1);
    h[`set${field}`] = (value) => {
      h[key] = typeof value === 'function' ? value(h[key]) : value;
    };
  }
  vm.runInNewContext(code, h);

  // Enter 插件 -> switch to MCP -> close -> re-enter 插件: must reset to 插件 tab.
  await h.openSettings('plugins');
  await h.selectPluginSection('mcp');
  assert.equal(h.settingsTab, 'plugins');
  assert.equal(h.pluginSection, 'mcp');

  // Clicking 插件 in settings sidebar while on MCP also returns to 插件 default tab.
  await h.selectSettingsTab('plugins');
  assert.equal(h.pluginSection, 'plugins');

  // Switch to 扩展, then return home; reopening 设置 lands on 通用, reopening 插件 lands on 插件.
  await h.selectPluginSection('extensions');
  h.extensionDetail = { id: 'demo' };
  await h.closeSettings();
  assert.equal(h.settingsOpen, false);
  assert.equal(h.settingsTab, 'general');
  assert.equal(h.pluginSection, 'plugins');
  assert.equal(h.extensionDetail, null);
  assert.equal(skillClosed, 1);
  assert.equal(mcpClosed, 1);

  await h.openSettings();
  assert.equal(h.settingsTab, 'general');
  assert.equal(h.pluginSection, 'plugins');

  // Deep link to extensions still lands on 扩展 directly.
  await h.openSettings('extensions');
  assert.equal(h.settingsTab, 'plugins');
  assert.equal(h.pluginSection, 'extensions');

  // Agents hub deep links and section switching work and reset on close.
  await h.openSettings('subagents');
  assert.equal(h.settingsTab, 'agents');
  assert.equal(h.agentSection, 'subagents');
  await h.selectAgentSection('temporary');
  assert.equal(h.agentSection, 'temporary');
  await h.closeSettings();
  assert.equal(h.agentSection, 'main');

  // Model page transient view/filter/expansion resets when leaving page or closing settings.
  await h.selectSettingsTab('models');
  assert.equal(h.pluginSection, 'plugins');
  h.modelView = 'provider';
  h.modelQuery = 'gpt';
  h.expandedProvider = 'openai';
  h.providerDiscovery = { openai: { loading: false, models: [] } };
  const beforeClose = h.providerDiscoveryRequestsRef.current.get('openai');
  await h.closeSettings();
  assert.equal(h.modelView, 'all');
  assert.equal(h.modelQuery, '');
  assert.equal(h.expandedProvider, null);
  assert.equal(Object.keys(h.providerDiscovery).length, 0);
  assert.equal(h.providerDiscoveryRequestsRef.current.get('openai'), beforeClose + 1);
});
