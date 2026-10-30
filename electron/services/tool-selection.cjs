/**
 * Studio Agent-tool selection.
 *
 * The whitelist and source snapshots live in Studio SQLite. The live catalog is
 * read from the Durable registry, which is the single source of truth for tools
 * currently installed by core, Studio built-ins, MCP servers, and extensions.
 */

const path = require('node:path');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const { getDurableRuntime } = require('./durable-runtime.cjs');
const { extensionHostSnapshot, runtimeExtensionName } = require('./studio-extensions.cjs');
const { mcpSnapshot } = require('./mcp-runtime.cjs');
const { LONG_TASK_EXTENSION_NAME, LONG_TASK_TOOL_NAME } = require('./studio-long-task.cjs');

const SETTING_KEY = 'studio.agent.tools';
const SETTING_VERSION_KEY = 'studio.agent.tools.version';
const SETTING_VERSION = 3;
const DEFAULT_AGENT_TOOLS = Object.freeze([
  'read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'todo', 'tool_search', 'mcp__*',
]);
const MAX_AGENT_TOOLS = 256;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

function isValidToolName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 120
    && /^[A-Za-z0-9_.:*\-]+$/.test(value)
    && !RESERVED.has(value);
}

function normalizeNames(input, strict = false) {
  if (!Array.isArray(input)) {
    if (strict) throw new Error('智能体工具列表格式无效');
    return [...DEFAULT_AGENT_TOOLS];
  }
  if (input.length > MAX_AGENT_TOOLS) throw new Error(`智能体工具最多允许 ${MAX_AGENT_TOOLS} 项`);
  const seen = new Set();
  const names = [];
  for (const raw of input) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!isValidToolName(name)) {
      if (strict) throw new Error(`智能体工具名称无效：${String(raw)}`);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function normalizeSources(input, enabled) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const allowed = new Set(enabled);
  const text = (value, limit = 2048) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const result = {};
  for (const [name, value] of Object.entries(input)) {
    if (!allowed.has(name) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const source = text(value.source, 256);
    if (!source) continue;
    result[name] = {
      source,
      label: text(value.label, 160) || source,
      scope: ['user', 'project', 'temporary', 'manual', 'builtin'].includes(value.scope)
        ? value.scope
        : 'user',
      path: text(value.path),
      baseDir: text(value.baseDir),
    };
  }
  return result;
}

function normalizeSelection(input, strict = false) {
  const enabled = normalizeNames(Array.isArray(input) ? input : input?.enabled, strict);
  return {
    enabled,
    sources: normalizeSources(input && !Array.isArray(input) ? input.sources : undefined, enabled),
  };
}

function readAgentToolSelection(db = getStudioDatabase()) {
  const stored = db.getSetting(SETTING_KEY, undefined);
  if (stored === undefined) {
    db.setSetting(SETTING_VERSION_KEY, SETTING_VERSION);
    return normalizeSelection({ enabled: DEFAULT_AGENT_TOOLS, sources: {} });
  }
  const selection = normalizeSelection(stored);
  const version = Number(db.getSetting(SETTING_VERSION_KEY, 1)) || 1;
  if (version < SETTING_VERSION) {
    if (version < 2 && !selection.enabled.some((name) => name.startsWith('mcp__'))) {
      selection.enabled.push('mcp__*');
    }
    if (version < 3 && !selection.enabled.some((pattern) => matches(pattern, 'todo'))) {
      selection.enabled.push('todo');
    }
    db.setSetting(SETTING_KEY, selection);
    db.setSetting(SETTING_VERSION_KEY, SETTING_VERSION);
  }
  return selection;
}

function saveInstalledToolSelection(input, db = getStudioDatabase()) {
  const next = normalizeSelection(input, true);
  db.setSetting(SETTING_KEY, next);
  db.setSetting(SETTING_VERSION_KEY, SETTING_VERSION);
  return next;
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function matches(pattern, name) {
  if (pattern === '*' || pattern === name) return true;
  if (!pattern.includes('*')) return false;
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(name);
}

function sourceForExtension(runtimeName, mcp, extensionRows) {
  if (runtimeName === 'studio-mcp-catalog') {
    return {
      key: 'mcp:servers',
      source: 'mcp:servers',
      label: 'MCP · 工具目录',
      kind: 'mcp',
      scope: 'user',
      path: '',
      baseDir: '',
    };
  }
  if (runtimeName.startsWith('studio-mcp:')) {
    const server = runtimeName.slice('studio-mcp:'.length);
    const error = mcp.errors.find((item) => item.server === server);
    return {
      key: `mcp:${server}`,
      source: `mcp:${server}`,
      label: `MCP · ${server}`,
      kind: 'mcp',
      scope: 'user',
      path: '',
      baseDir: '',
      error: error?.message || '',
    };
  }
  const row = extensionRows.find((item) => (
    item.scope === 'builtin'
      ? (item.manifest?.runtimeNames || [item.manifest?.runtimeName]).includes(runtimeName)
      : runtimeExtensionName(item.id) === runtimeName
  ));
  if (row) {
    return {
      key: row.id,
      source: row.source,
      label: row.name,
      kind: row.scope === 'builtin' ? 'core' : row.scope === 'project' ? 'local' : 'extension',
      scope: row.scope,
      path: row.source,
      baseDir: row.scope === 'builtin' ? '' : path.dirname(row.source),
    };
  }
  if (runtimeName === 'coding-tools') {
    return {
      key: 'durable:coding',
      source: 'durable:coding',
      label: 'Pi Durable · Coding',
      kind: 'core',
      scope: 'builtin',
      path: '',
      baseDir: '',
    };
  }
  return {
    key: `extension:${runtimeName}`,
    source: runtimeName,
    label: runtimeName,
    kind: 'extension',
    scope: 'user',
    path: '',
    baseDir: '',
  };
}

async function agentToolCatalog(refresh = false) {
  if (refresh) await getDurableRuntime();
  const runtime = await getDurableRuntime();
  const snapshot = runtime.registry.snapshot();
  const extensionSnapshot = extensionHostSnapshot();
  const mcp = mcpSnapshot();
  const rows = extensionSnapshot.extensions;
  const tools = snapshot.tools().map(({ extension, tool }) => ({
    name: tool.name,
    description: tool.description || '',
    exposure: tool.deferred
      ? 'on-demand'
      : Array.isArray(tool.callers) && !tool.callers.includes('model')
        ? 'hidden'
        : 'direct',
    source: sourceForExtension(extension.name, mcp, rows),
  })).sort((left, right) => (
    left.source.label.localeCompare(right.source.label)
    || left.name.localeCompare(right.name)
  ));
  const commands = rows.flatMap((row) => (
    (row.manifest?.contributes?.commands || []).map((command) => ({
      name: command.id,
      description: command.description || command.title,
      source: {
        key: row.id,
        source: row.source,
        label: row.name,
        kind: row.scope === 'builtin' ? 'core' : 'extension',
        scope: row.scope,
        path: row.source,
        baseDir: row.scope === 'builtin' ? '' : path.dirname(row.source),
      },
    }))
  )).sort((left, right) => left.name.localeCompare(right.name));
  return {
    tools,
    commands,
    errors: [
      ...extensionSnapshot.errors,
      ...mcp.errors.map((item) => ({
        path: `mcp:${item.server}`,
        message: item.message,
      })),
    ],
    warnings: rows
      .filter((row) => row.scope === 'project' && !row.trusted)
      .map((row) => ({ path: row.source, message: '项目扩展尚未信任，未加载到运行时。' })),
    storage: 'SQLite · settings/studio.agent.tools',
    refreshedAt: Date.now(),
  };
}

async function enabledRuntimeToolNames() {
  const runtime = await getDurableRuntime();
  const selected = readAgentToolSelection();
  const installed = runtime.registry.snapshot().tools().map(({ tool }) => tool.name);
  return installed.filter((name) => selected.enabled.some((pattern) => matches(pattern, name)));
}

async function runtimeSelection(options = {}) {
  const runtime = await getDurableRuntime();
  const snapshot = runtime.registry.snapshot();
  const extensionSnapshot = extensionHostSnapshot();
  const mcp = mcpSnapshot();
  const activeRuntimeNames = new Set(extensionSnapshot.extensions.flatMap((row) => {
    if (!row.enabled || !row.trusted || !row.available) return [];
    return row.scope === 'builtin'
      ? row.manifest?.runtimeNames || [row.manifest?.runtimeName || row.id]
      : [runtimeExtensionName(row.id)];
  }));
  // The extension is core so its implementation cannot be replaced, but its
  // continuation hook and model tool are only selected for long-running goals.
  activeRuntimeNames.delete(LONG_TASK_EXTENSION_NAME);
  if (options.kind === 'durable' && snapshot.extension(LONG_TASK_EXTENSION_NAME)) {
    activeRuntimeNames.add(LONG_TASK_EXTENSION_NAME);
  }
  const selected = readAgentToolSelection();
  const enabledMcpEntries = snapshot.tools().filter(({ extension, tool }) => (
    extension.name.startsWith('studio-mcp:')
    && selected.enabled.some((pattern) => matches(pattern, tool.name))
  ));
  for (const { extension } of enabledMcpEntries) activeRuntimeNames.add(extension.name);
  const needsToolSearch = snapshot.tools().some(({ extension, tool }) => (
    activeRuntimeNames.has(extension.name)
    && tool.deferred
    && selected.enabled.some((pattern) => matches(pattern, tool.name))
  ));
  if (needsToolSearch) activeRuntimeNames.add('tool-search');
  if (needsToolSearch && enabledMcpEntries.some(({ tool }) => tool.deferred)) {
    activeRuntimeNames.add(mcp.catalogRuntimeName);
  }
  const tools = snapshot.tools()
    .filter(({ extension, tool }) => (
      activeRuntimeNames.has(extension.name)
      && (
        selected.enabled.some((pattern) => matches(pattern, tool.name))
        || (needsToolSearch && tool.name === 'tool_search')
        || (
          extension.name === LONG_TASK_EXTENSION_NAME
          && tool.name === LONG_TASK_TOOL_NAME
        )
      )
    ))
    .map(({ tool }) => tool);
  const extensions = snapshot.installed().filter((extension) => activeRuntimeNames.has(extension.name));
  return { extensions, tools };
}

module.exports = {
  DEFAULT_AGENT_TOOLS,
  agentToolCatalog,
  enabledRuntimeToolNames,
  isValidToolName,
  matches,
  normalizeSelection,
  readAgentToolSelection,
  runtimeSelection,
  saveInstalledToolSelection,
};
