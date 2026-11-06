import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function compile(relative, imports = {}) {
  const context = { exports: {}, require: id => id.endsWith('.css') ? {} : imports[id] ?? require(id) };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.exports;
}

const { ModelSettings } = compile('../../web/src/features/models/ModelSettings.tsx', {
  '../../shared/SettingsPageHeader': {
    SettingsPageHeader: ({ title, actions }) => React.createElement(
      'header',
      { className: 'settings-page-header' },
      React.createElement('h1', null, title),
      actions,
    ),
  },
  '../../shared/Select': { Select: () => null },
  '../../shared/InfoHint': { InfoHint: () => null },
  '../../shared/token-units': { tokenLabel: value => `${value} tokens` },
  '../../types/model-types': { thinkingLabels: {} },
  './model-settings-catalog.mjs': {
    discoverySelection: () => ({}),
    MODEL_CATALOG_PAGE_SIZE: 20,
    modelCatalogPage: () => ({ items: [], total: 0, remaining: 0 }),
  },
});

test('first-run model settings replace three empty sections with one clear connection task', () => {
  const addProvider = [];
  const html = renderToStaticMarkup(React.createElement(ModelSettings, {
    providers: [],
    models: [],
    enabledModels: [],
    defaultModelSelection: {
      modelRef: '',
      label: '',
      thinkingLevel: 'default',
      thinkingLevels: ['default'],
      effectiveThinkingLevel: 'off',
    },
    defaultModelBusy: false,
    settingsBusy: false,
    providerModels: {},
    providerCatalogState: {},
    providerDiscovery: {},
    expandedProvider: null,
    modelView: 'all',
    modelQuery: '',
    actions: { onAddProvider: () => addProvider.push(true) },
  }));
  assert.match(html, /连接一个模型来源/);
  assert.match(html, /添加模型来源后，即可启用模型并选择新对话的默认模型/);
  assert.equal((html.match(/<button[^>]*>[\s\S]*?添加模型来源<\/button>/g) || []).length, 1, 'the primary action appears once');
  assert.match(html, /id="model-first-run-heading"/);
  assert.doesNotMatch(html, /新对话默认|已启用模型|模型来源 <span/);
});
