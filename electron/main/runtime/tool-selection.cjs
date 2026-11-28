/**
 * Studio Agent-tool selection.
 *
 * Profile persistence lives in core/tool-profiles.cjs (SQLite). The live catalog
 * is read from the Durable registry, which is the single source of truth for
 * tools currently installed by core, Studio built-ins, MCP servers, and extensions.
 */

const path = require('node:path');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const { isBrowserAgentControlEnabled } = require('../services/browser/settings.cjs');
const { getDesktopControlPreferences } = require('../services/desktop-control/policy.cjs');
const { getDurableRuntime } = require('./durable-runtime.cjs');
const {
  extensionHostSnapshot,
  runtimeExtensionName,
  temporarySafeExtensions,
} = require('../services/studio-extensions.cjs');
const { mcpSnapshot } = require('../integrations/mcp/index.cjs');
const {
  LONG_TASK_EXTENSION_NAME,
  LONG_TASK_TOOL_NAME,
} = require('../capabilities/long-task/index.cjs');
const {
  DEFAULT_AGENT_TOOLS,
  MCP_RULES_KEY,
  deleteToolProfile,
  getToolProfilesSnapshot,
  isValidToolName,
  matches,
  mcpRulesFrom,
  normalizeSelection,
  readAgentToolSelection,
  resetToolProfile,
  resolveMainToolProfile,
  resolveTemporaryToolProfile,
  saveInstalledToolSelection,
  saveToolProfile,
  selectToolProfile,
} = require('../core/tool-profiles.cjs');

const TEMPORARY_EXCLUDED_BUILTIN_RUNTIMES = new Set([
  'studio-subagents',
  'studio-subagent-channel',
  'studio-long-task',
  'studio-todo',
  'studio-workbench-tools',
  'studio-skills',
  'studio-permissions',
  'studio-harness',
  'studio-request-trace',
  'studio-metrics',
  'studio-image-fit',
  'studio-desktop-control',
]);

function enabledMcpMethodNames(methods, selection, db = getStudioDatabase()) {
  const rules = db.getSetting(MCP_RULES_KEY, mcpRulesFrom(selection));
  return new Set(methods.filter((method) => typeof method.enabledOverride === 'boolean'
    ? method.enabledOverride
    : Array.isArray(rules) && rules.some((rule) => typeof rule === 'string' && matches(rule, method.name))
  ).map((method) => method.name));
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
  const available = candidates.filter((text) => typeof text === 'string' && text.trim());
  return available.find((text) => /\p{Script=Han}/u.test(text)) || available[0] || '';
}

async function agentToolCatalog(refresh = false) {
  if (refresh) await getDurableRuntime();
  const runtime = await getDurableRuntime();
  const snapshot = runtime.registry.snapshot();
  const extensionSnapshot = extensionHostSnapshot();
  const mcp = mcpSnapshot();
  const rows = extensionSnapshot.extensions;
  const enabledMcp = enabledMcpMethodNames(mcp.tools, readAgentToolSelection());
  const manifests = new Map(rows.map((row) => [row.id, row.manifest]));
  const tools = snapshot.tools().map(({ extension, tool }) => {
    const source = sourceForExtension(extension.name, mcp, rows);
    const declared = manifests.get(source.key)?.contributes?.tools?.find((item) => item.name === tool.name);
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

function mcpAllowedByProfile(profile, serverName) {
  if (!profile || profile.mcpMode === 'follow-server') return true;
  if (profile.mcpMode === 'none') return false;
  return Array.isArray(profile.mcpServers) && profile.mcpServers.includes(serverName);
}

function runtimeScopeSets(extensionSnapshot = extensionHostSnapshot(), mcp = mcpSnapshot()) {
  const builtinRuntimes = new Set(['coding-tools', 'tool-search', mcp.catalogRuntimeName]);
  const userRuntimes = new Set();
  for (const row of extensionSnapshot.extensions || []) {
    const names = row.scope === 'builtin'
      ? (row.manifest?.runtimeNames || [row.manifest?.runtimeName || row.id])
      : [runtimeExtensionName(row.id)];
    const target = row.scope === 'builtin' ? builtinRuntimes : userRuntimes;
    for (const name of names) {
      if (name) target.add(name);
    }
  }
  return { builtinRuntimes, userRuntimes };
}

function runtimeToolFilter(selection, mcp, profile, options = {}) {
  const enabledMcp = enabledMcpMethodNames(mcp.tools, selection);
  const allowedTools = profile?.enabled ?? selection.enabled;
  const extensionMode = profile?.extensionMode || 'all-enabled';
  const extensionSnapshot = options.extensionSnapshot ?? extensionHostSnapshot();
  const { builtinRuntimes, userRuntimes } = runtimeScopeSets(extensionSnapshot, mcp);
  const safeEntries = extensionMode === 'safe-only'
    ? (options.safeEntries ?? temporarySafeExtensions())
    : [];
  const safeToolKeys = extensionMode === 'safe-only'
    ? new Set(
      safeEntries.flatMap((entry) =>
        entry.toolNames.map((toolName) => `${entry.extension.name}\u0000${toolName}`),
      ),
    )
    : null;

  const browserControlEnabled = options.browserControlEnabled !== undefined
    ? Boolean(options.browserControlEnabled)
    : (() => {
      try { return isBrowserAgentControlEnabled(); } catch { return true; }
    })();

  const desktopControlEnabled = options.desktopControlEnabled !== undefined
    ? Boolean(options.desktopControlEnabled)
    : (() => {
      try { return Boolean(getDesktopControlPreferences().enabled); } catch { return false; }
    })();

  return ({ extension, tool }) => {
    if (extension.name === 'studio-browser-tools' && !browserControlEnabled) {
      return false;
    }
    if (extension.name === 'studio-desktop-control' && !desktopControlEnabled) {
      return false;
    }
    if (extension.name.startsWith('studio-mcp:')) {
      const serverName = extension.name.slice('studio-mcp:'.length);
      return mcpAllowedByProfile(profile, serverName) && enabledMcp.has(tool.name);
    }
    const isUserExtension = userRuntimes.has(extension.name) || !builtinRuntimes.has(extension.name);
    if (isUserExtension) {
      if (extensionMode === 'none') return false;
      if (extensionMode === 'safe-only' && !safeToolKeys?.has(`${extension.name}\u0000${tool.name}`)) {
        return false;
      }
    }
    return allowedTools.some((pattern) => matches(pattern, tool.name));
  };
}

function resolveProfileForOptions(options = {}, db = getStudioDatabase()) {
  if (options.profileId) {
    const snapshot = getToolProfilesSnapshot(options.cwd || '', db);
    const explicit = snapshot.profiles.find((profile) => profile.id === options.profileId);
    if (explicit) return explicit;
  }
  if (options.temporary) return resolveTemporaryToolProfile(db);
  return resolveMainToolProfile(options.cwd || '', db);
}

async function runtimeSelection(options = {}) {
  const runtime = await getDurableRuntime();
  const db = getStudioDatabase();
  const snapshot = runtime.registry.snapshot();
  const extensionSnapshot = extensionHostSnapshot();
  const mcp = mcpSnapshot();
  const profile = resolveProfileForOptions(options, db);
  const isTemporary = options.temporary === true;
  const activeRuntimeNames = new Set(extensionSnapshot.extensions.flatMap((row) => {
    if (!row.enabled || !row.trusted || !row.available) return [];
    if (isTemporary && row.scope === 'project') return [];
    if (profile.extensionMode === 'none' && row.scope !== 'builtin') return [];
    return row.scope === 'builtin'
      ? row.manifest?.runtimeNames || [row.manifest?.runtimeName || row.id]
      : [runtimeExtensionName(row.id)];
  }));
  if (isTemporary) {
    for (const excluded of TEMPORARY_EXCLUDED_BUILTIN_RUNTIMES) {
      activeRuntimeNames.delete(excluded);
    }
  } else {
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
  }

  const selected = readAgentToolSelection(db);
  const allowed = runtimeToolFilter(selected, mcp, profile, { extensionSnapshot });
  const enabledMcpEntries = snapshot.tools().filter((entry) => (
    entry.extension.name.startsWith('studio-mcp:') && allowed(entry)
  ));
  for (const { extension } of enabledMcpEntries) activeRuntimeNames.add(extension.name);
  const needsToolSearch = snapshot.tools().some((entry) => (
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
          !isTemporary
          && extension.name === LONG_TASK_EXTENSION_NAME
          && tool.name === LONG_TASK_TOOL_NAME
        )
      )
    ));
  const extensions = snapshot.installed().filter((extension) => activeRuntimeNames.has(extension.name));
  return {
    profile,
    extensions,
    tools: toolEntries.map(({ tool }) => tool),
    toolEntries,
  };
}

async function temporaryRuntimeSelection() {
  return runtimeSelection({ temporary: true });
}

async function temporaryCapabilitiesSnapshot() {
  const selection = await temporaryRuntimeSelection();
  const extensionSnapshot = extensionHostSnapshot();
  const { builtinRuntimes, userRuntimes } = runtimeScopeSets(extensionSnapshot, mcpSnapshot());
  const mcpServers = new Set();
  const extensionTools = [];
  const builtinTools = [];
  for (const { extension, tool } of selection.toolEntries) {
    if (extension.name.startsWith('studio-mcp:')) {
      mcpServers.add(extension.name.slice('studio-mcp:'.length));
    } else if (userRuntimes.has(extension.name) || !builtinRuntimes.has(extension.name)) {
      extensionTools.push(tool.name);
    } else {
      builtinTools.push(tool.name);
    }
  }
  return {
    profileId: selection.profile.id,
    profileName: selection.profile.name,
    builtinTools: [...new Set(builtinTools)].sort(),
    extensionTools: [...new Set(extensionTools)].sort(),
    mcpServers: [...mcpServers].sort(),
    totalTools: selection.tools.length,
  };
}

module.exports = {
  DEFAULT_AGENT_TOOLS,
  agentToolCatalog,
  deleteToolProfile,
  enabledMcpMethodNames,
  getToolProfilesSnapshot,
  isValidToolName,
  matches,
  normalizeSelection,
  readAgentToolSelection,
  resetToolProfile,
  resolveMainToolProfile,
  resolveTemporaryToolProfile,
  runtimeToolFilter,
  runtimeSelection,
  saveInstalledToolSelection,
  saveToolProfile,
  selectToolProfile,
  temporaryCapabilitiesSnapshot,
  temporaryRuntimeSelection,
};
