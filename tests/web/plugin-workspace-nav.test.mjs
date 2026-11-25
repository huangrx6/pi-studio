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

test('resolveSettingsDestination maps mcp/skills deep links into plugin hub', () => {
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
  assert.equal(plugins.pluginSection, undefined);
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
