import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const installedSkillsCss = fs.readFileSync(new URL('../../web/src/features/skills/installed-skills.css', import.meta.url), 'utf8');

const require = createRequire(import.meta.url);
const root = new URL('../../web/src/features/', import.meta.url);

function compile(path, stubs) {
  const source = fs.readFileSync(new URL(path, root), 'utf8');
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

const Header = ({ title, meta, actions }) => React.createElement('header', null,
  React.createElement('h1', null, title), meta, actions);
const SafeReact = { ...React, useLayoutEffect: React.useEffect };
const EmptyIcons = {
  ArchiveRestore: () => null, LoaderCircle: () => null, Search: () => null, X: () => null,
  RefreshCw: () => null,
};

test('archive with no sessions hides a useless search and count, leaving one explicit empty state', () => {
  const { ArchivedConversationsSettings } = compile('archives/ArchivedConversationsSettings.tsx', {
    react: SafeReact,
    'lucide-react': EmptyIcons,
    '../../shared/SettingsPageHeader': { SettingsPageHeader: Header },
    '../../shared/error-text': { errorText: error => String(error) },
    '../../shared/keyboard-navigation': { isComposingKey: () => false },
    './archive-filter': {
      filterArchivedWorkspaces: workspaces => workspaces.filter(workspace => workspace.sessions.length),
    },
  });
  const empty = renderToStaticMarkup(React.createElement(ArchivedConversationsSettings, {
    workspaces: [], onRestore: async () => {}, onDelete: async () => {},
  }));
  assert.doesNotMatch(empty, /archive-search/);
  assert.doesNotMatch(empty, />0 个归档会话</);
  assert.equal((empty.match(/还没有归档会话/g) || []).length, 1);
  assert.match(empty, /归档的会话会保留在这里，可随时恢复/);

  const populated = renderToStaticMarkup(React.createElement(ArchivedConversationsSettings, {
    workspaces: [{ cwd: '/A', name: 'A', sessions: [{ id: 'a', cwd: '/A', title: 'A', archived: true, updatedAt: 1 }] }],
    onRestore: async () => {}, onDelete: async () => {},
  }));
  assert.match(populated, /archive-search/);
  assert.match(populated, /1 个归档会话/);
});

test('installed skills render one empty state and only populated groups', () => {
  const { InstalledSkills } = compile('skills/InstalledSkills.tsx', {
    react: React,
    'lucide-react': { ChevronRight: () => null, Trash2: () => null },
    '../../shared/EmptyStateArt': { EmptyStateArt: () => null },
    '../../shared/StatusGlyph': { StatusGlyph: () => null },

    './installed-skill-status': {
      installedSkillStatus: (skill) => ({ label: skill.disableModelInvocation ? '仅显式调用' : '自动发现', canTrust: false }),
    },
  });
  const paths = {
    userStudio: '/skills/user-studio', userAgents: '/skills/user-agents',
    projectStudio: '/skills/project-studio', projectAgents: '/skills/project-agents',
  };
  const render = (skills, errors = []) => renderToStaticMarkup(React.createElement(InstalledSkills, {
    skills, errors, paths, workspaceName: 'A', busy: false,
    onOpen() {}, onTrust() {}, onDelete() {},
  }));
  const empty = render([]);
  assert.doesNotMatch(empty, />0 个</);
  assert.doesNotMatch(empty, /暂无技能/);
  assert.equal((empty.match(/还没有已安装技能/g) || []).length, 1);
  assert.equal((empty.match(/<summary>技能目录<\/summary>/g) || []).length, 1);
  assert.doesNotMatch(empty, /项目技能需审查/);

  const userOnly = render([{
    name: '用户技能', description: '说明', path: '/skills/user', scope: 'user', origin: 'studio',
    available: true, trusted: true, trustChanged: false, disableModelInvocation: false,
  }]);
  assert.match(userOnly, /Studio 应用技能/);
  assert.match(userOnly, /默认自动发现/);
  assert.match(userOnly, /data-invocation="auto"/);
  assert.doesNotMatch(userOnly, /class="installed-skill-status">自动发现/);
  assert.doesNotMatch(userOnly, /<h3>Studio 项目技能<\/h3>/);
  assert.doesNotMatch(userOnly, /项目技能需审查/);
});

test('installed skill descriptions stay compact until the detail view is opened', () => {
  assert.match(installedSkillsCss, /\.installed-skill-copy p\s*\{[^}]*-webkit-line-clamp: 2;/);
  assert.match(installedSkillsCss, /\.installed-skill-copy p\s*\{[^}]*overflow: hidden;/);
});

test('MCP zero state relies on the primary add action without a redundant zero counter', () => {
  const { McpSettings } = compile('mcp/McpSettings.tsx', {
    react: React,
    'lucide-react': { ChevronRight: () => null, Pencil: () => null, Plus: () => null, Trash2: () => null },
    '../../shared/EmptyStateArt': { EmptyStateArt: () => null },
    '../../shared/StatusGlyph': { StatusGlyph: () => null },

    '../../shared/InfoHint': { InfoHint: ({ label }) => React.createElement('span', null, label) },
    '../../shared/SettingsPageHeader': { SettingsPageHeader: Header },
    './mcp-status': { mcpConnectionStatus: () => ({ label: '未连接', state: 'disabled' }) },
  });
  const html = renderToStaticMarkup(React.createElement(McpSettings, {
    servers: [], busy: false, onAdd() {}, onOpen() {}, onEdit() {}, onToggle() {}, onDelete() {},
  }));
  assert.match(html, /添加服务器/);
  assert.match(html, /还没有 MCP 服务器/);
  assert.doesNotMatch(html, /0 个服务器/);
  assert.doesNotMatch(html, /tool_search/);
});

test('zero usage hides empty charts and zero-value workbench behind one first-run state', () => {
  const totals = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, requests: 0,
    activeDays: 0, currentStreak: 0, longestStreak: 0,
  };
  const snapshot = {
    generatedAt: Date.now(), days: 365, sinceDay: '2025-11-07',
    collection: { enabled: true }, allTime: totals, range: totals,
    daily: [], dailyModels: [], filterModels: [],
  };
  const resource = { value: snapshot, pending: false, error: null };
  const { UsageSettings } = compile('usage/UsageSettings.tsx', {
    react: React,
    'lucide-react': EmptyIcons,
    '../../shared/DatePicker': { DatePicker: () => null },
    '../../shared/Select': { Select: () => null },
    '../../shared/InfoHint': { InfoHint: ({ label }) => React.createElement('span', null, label) },
    '../../shared/SettingsPageHeader': { SettingsPageHeader: Header },
    './UsageSparkline': { UsageSparkline: () => null },
    './usage-presentation': {
      ALL_MODELS: 'all', dayFromToday: () => '2026-11-06', dayKey: () => '2026-11-06',
      heatLevel: () => 0, heatmapDates: () => [], heatmapNavigation: () => null,
      modelKey: (provider, model) => `${provider}:${model}`, shareLabel: () => '0%', shareOf: () => 0,
      tokenParts: () => [], usageModelWindow: () => ({ all: true }),
    },
    './use-usage-resource': { useUsageResource: () => resource },
  });
  const html = renderToStaticMarkup(React.createElement(UsageSettings, { active: true }));
  assert.match(html, /还没有使用记录/);
  assert.match(html, /开始对话后，这里会显示按本地日期汇总的 Token 和请求/);
  assert.doesNotMatch(html, /usage-hero/);
  assert.doesNotMatch(html, /usage-heatmap/);
  assert.doesNotMatch(html, /usage-models-card/);
  assert.doesNotMatch(html, /热力图日期范围/);
  assert.doesNotMatch(html, /这个时间范围内没有模型请求/);
});
