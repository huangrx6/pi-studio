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
const { extensionHostSnapshot, runtimeExtensionName } = require('../services/studio-extensions.cjs');
const { mcpSnapshot } = require('../integrations/mcp/index.cjs');
const {
  LONG_TASK_EXTENSION_NAME,
  LONG_TASK_TOOL_NAME,
} = require('../capabilities/long-task/index.cjs');

const SETTING_KEY = 'studio.agent.tools';
const SETTING_VERSION_KEY = 'studio.agent.tools.version';
const SETTING_VERSION = 6;
const MCP_RULES_KEY = 'studio.mcp.methodRules.v1';
const DEFAULT_AGENT_TOOLS = Object.freeze([
  'read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'todo', 'tool_search',
  'browser_tabs', 'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_screenshot',
  'browser_click', 'browser_type', 'browser_scroll', 'browser_wait', 'browser_select',
  'browser_dialog', 'browser_download', 'browser_highlight',
  'mcp__*',
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
  if (strict && input.length > MAX_AGENT_TOOLS) {
    throw new Error(`智能体工具最多允许 ${MAX_AGENT_TOOLS} 项`);
  }
  const seen = new Set();
  const names = [];
  for (const raw of input) {
    if (names.length >= MAX_AGENT_TOOLS) break;
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
    if (
      RESERVED.has(name)
      || !allowed.has(name)
      || !value
      || typeof value !== 'object'
      || Array.isArray(value)
    ) continue;
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

function normalizeSelectionVersion(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

function readAgentToolSelection(db = getStudioDatabase()) {
  const selectionExists = Object.hasOwn(db.getSettings(), SETTING_KEY);
  const selection = db.getSettingWithRecovery(
    SETTING_KEY,
    undefined,
    normalizeSelection,
  );
  if (!selectionExists) return selection;
  const version = db.getSettingWithRecovery(
    SETTING_VERSION_KEY,
    1,
    normalizeSelectionVersion,
  );
  if (version < SETTING_VERSION) {
    if (version < 2 && !selection.enabled.some((name) => name.startsWith('mcp__'))) {
      if (selection.enabled.length < MAX_AGENT_TOOLS) selection.enabled.push('mcp__*');
    }
    if (version < 3 && !selection.enabled.some((pattern) => matches(pattern, 'todo'))) {
      if (selection.enabled.length < MAX_AGENT_TOOLS) selection.enabled.push('todo');
    }
    if (version < 4) {
      const browserTools = [
        'browser_tabs',
        'browser_open',
        'browser_navigate',
        'browser_snapshot',
        'browser_screenshot',
      ];
      for (const name of browserTools) {
        if (selection.enabled.some((pattern) => matches(pattern, name))) continue;
        if (selection.enabled.length >= MAX_AGENT_TOOLS) break;
        selection.enabled.push(name);
      }
    }
    if (version < 5) {
      const actTools = [
        'browser_click',
        'browser_type',
        'browser_scroll',
        'browser_wait',
        'browser_select',
        'browser_dialog',
        'browser_download',
      ];
      for (const name of actTools) {
        if (selection.enabled.some((pattern) => matches(pattern, name))) continue;
        if (selection.enabled.length >= MAX_AGENT_TOOLS) break;
        selection.enabled.push(name);
      }
    }
    if (version < 6) {
      if (!selection.enabled.some((pattern) => matches(pattern, 'browser_highlight'))) {
        if (selection.enabled.length < MAX_AGENT_TOOLS) selection.enabled.push('browser_highlight');
      }
    }
    const migrated = normalizeSelection(selection);
    try {
      db.transaction(() => {
        db.setSetting(SETTING_KEY, migrated);
        db.setSetting(SETTING_VERSION_KEY, SETTING_VERSION);
      });
    } catch {
      // Migration still yields a safe in-memory selection when either repair
      // write fails. The next read retries the idempotent migration.
    }
    return migrated;
  }
  return selection;
}

// Keep historical MCP decisions, including overlapping wildcards and offline servers.
// After the two editors split, a local tool edit must never change this baseline.
function mcpRulesFrom(selection) {
  return selection.enabled.filter(name => name.startsWith('mcp__') || name.includes('*'));
}

function enabledMcpMethodNames(methods, selection, db = getStudioDatabase()) {
  const rules = db.getSetting(MCP_RULES_KEY, mcpRulesFrom(selection));
  return new Set(methods.filter(method => typeof method.enabledOverride === 'boolean'
    ? method.enabledOverride
    : Array.isArray(rules) && rules.some(rule => typeof rule === 'string' && matches(rule, method.name))
  ).map(method => method.name));
}

function saveInstalledToolSelection(input, db = getStudioDatabase(), { inTransaction = false } = {}) {
  const selection = normalizeSelection(input, true);
  // Old callers may echo a mixed snapshot. Only the local part belongs to this editor.
  const enabled = selection.enabled.filter(name => !name.startsWith('mcp__'));
  const next = { enabled, sources: normalizeSources(selection.sources, enabled) };
  const inherited = db.getSetting(MCP_RULES_KEY, null) === null ? mcpRulesFrom(readAgentToolSelection(db)) : null;
  const write = () => {
    if (inherited !== null) db.setSetting(MCP_RULES_KEY, inherited);
    db.setSetting(SETTING_KEY, next);
    db.setSetting(SETTING_VERSION_KEY, SETTING_VERSION);
  };
  if (inTransaction) write();
  else db.transaction(write);
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

function catalogDescription(...candidates) {
  const available = candidates.filter(text => typeof text === 'string' && text.trim());
  return available.find(text => /\p{Script=Han}/u.test(text)) || available[0] || '';
}

async function agentToolCatalog(refresh = false) {
  if (refresh) await getDurableRuntime();
  const runtime = await getDurableRuntime();
  const snapshot = runtime.registry.snapshot();
  const extensionSnapshot = extensionHostSnapshot();
  const mcp = mcpSnapshot();
  const rows = extensionSnapshot.extensions;
  const enabledMcp = enabledMcpMethodNames(mcp.tools, readAgentToolSelection());
  const manifests = new Map(rows.map(row => [row.id, row.manifest]));
  const tools = snapshot.tools().map(({ extension, tool }) => {
    const source = sourceForExtension(extension.name, mcp, rows);
    const declared = manifests.get(source.key)?.contributes?.tools?.find(item => item.name === tool.name);
    return {
      name: tool.name,
      description: catalogDescription(declared?.description, tool.description),
      exposure: tool.deferred
        ? 'on-demand'
        : Array.isArray(tool.callers) && !tool.callers.includes('model')
          ? 'hidden'
          : 'direct',
      source,
      ...(source.kind === 'mcp' ? { enabled: enabledMcp.has(tool.name) } : {}),
    };
  }).sort((left, right) => (
    left.source.label.localeCompare(right.source.label)
    || left.name.localeCompare(right.name)
  ));
  const commands = rows.flatMap((row) => (
    (row.manifest?.contributes?.commands || []).map((command) => ({
      name: command.id,
      description: catalogDescription(command.description, command.title),
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
  const allowed = runtimeToolFilter(selected, mcpSnapshot());
  return runtime.registry.snapshot().tools().filter(allowed).map(({ tool }) => tool.name);
}

function runtimeToolFilter(selection, mcp) {
  const enabledMcp = enabledMcpMethodNames(mcp.tools, selection);
  return ({ extension, tool }) => extension.name.startsWith('studio-mcp:')
    ? enabledMcp.has(tool.name)
    : selection.enabled.some(pattern => matches(pattern, tool.name));
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
  // The extension is core so its implementation cannot be replaced. It is
  // activated lazily when a conversation has a persisted goal; legacy durable
  // rows continue to request it through their kind.
  activeRuntimeNames.delete(LONG_TASK_EXTENSION_NAME);
  if (
    (options.longTask === true || options.kind === 'durable')
    && snapshot.extension(LONG_TASK_EXTENSION_NAME)
  ) {
    activeRuntimeNames.add(LONG_TASK_EXTENSION_NAME);
  }
  const selected = readAgentToolSelection();
  const allowed = runtimeToolFilter(selected, mcp);
  const enabledMcpEntries = snapshot.tools().filter(entry => (
    entry.extension.name.startsWith('studio-mcp:') && allowed(entry)
  ));
  for (const { extension } of enabledMcpEntries) activeRuntimeNames.add(extension.name);
  const needsToolSearch = snapshot.tools().some(entry => (
    activeRuntimeNames.has(entry.extension.name) && entry.tool.deferred && allowed(entry)
  ));
  if (needsToolSearch) activeRuntimeNames.add('tool-search');
  if (needsToolSearch && enabledMcpEntries.some(({ tool }) => tool.deferred)) {
    activeRuntimeNames.add(mcp.catalogRuntimeName);
  }
  const toolEntries = snapshot.tools()
    .filter(({ extension, tool }) => (
      activeRuntimeNames.has(extension.name)
      && (
        allowed({ extension, tool })
        || (needsToolSearch && tool.name === 'tool_search')
        || (
          extension.name === LONG_TASK_EXTENSION_NAME
          && tool.name === LONG_TASK_TOOL_NAME
        )
      )
    ));
  const extensions = snapshot.installed().filter((extension) => activeRuntimeNames.has(extension.name));
  return { extensions, tools: toolEntries.map(({ tool }) => tool), toolEntries };
}

module.exports = {
  DEFAULT_AGENT_TOOLS,
  agentToolCatalog,
  enabledRuntimeToolNames,
  enabledMcpMethodNames,
  isValidToolName,
  matches,
  normalizeSelection,
  readAgentToolSelection,
  runtimeSelection,
  saveInstalledToolSelection,
};
