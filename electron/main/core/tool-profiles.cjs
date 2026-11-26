/**
 * Persisted Agent Tool profiles and workspace/temporary bindings.
 *
 * Pure SQLite + validation layer (no runtime or Durable dependencies) so both
 * app-settings and runtime/tool-selection can share one source of truth.
 */

const path = require('node:path');
const { normalizeProfileIcon } = require('./profile-icon.cjs');
const { getStudioDatabase } = require('./studio-db.cjs');

const SETTING_KEY = 'studio.agent.tools';
const SETTING_VERSION_KEY = 'studio.agent.tools.version';
const SETTING_VERSION = 8;
const MCP_RULES_KEY = 'studio.mcp.methodRules.v1';
const TOOL_PROFILES_KEY = 'studio.agent.toolProfiles.v1';

const DEFAULT_AGENT_TOOLS = Object.freeze([
  'read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'todo', 'tool_search', 'workbench_refresh',
  'browser_tabs', 'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_screenshot',
  'browser_click', 'browser_hover', 'browser_type', 'browser_press', 'browser_drag',
  'browser_scroll', 'browser_wait', 'browser_select', 'browser_viewport',
  'browser_console', 'browser_network',
  'browser_dialog', 'browser_download', 'browser_highlight',
  'mcp__*',
]);

const MAIN_DEFAULT_PROFILE_ID = 'main-default';
const TEMPORARY_DEFAULT_PROFILE_ID = 'temporary-default';
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const MAX_TOOL_PROFILES = 24;
const MAX_AGENT_TOOLS = 256;
const MAX_MCP_SERVERS = 128;
const EXTENSION_MODES = new Set(['all-enabled', 'safe-only', 'none']);
const MCP_MODES = new Set(['follow-server', 'picked', 'none']);
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isValidToolName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 120
    && /^[A-Za-z0-9_.:*\-]+$/.test(value)
    && !RESERVED.has(value);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function matches(pattern, name) {
  if (pattern === '*' || pattern === name) return true;
  if (!pattern.includes('*')) return false;
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(name);
}

function normalizeNames(input, strict = false, fallback = DEFAULT_AGENT_TOOLS) {
  if (!Array.isArray(input)) {
    if (strict) throw new Error('智能体工具列表格式无效');
    return [...fallback];
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
  const text = (value, limit = 2048) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');
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
    if (version < 7) {
      if (!selection.enabled.some((pattern) => matches(pattern, 'workbench_refresh'))) {
        if (selection.enabled.length < MAX_AGENT_TOOLS) selection.enabled.push('workbench_refresh');
      }
    }
    if (version < 8) {
      const devtoolsParityTools = [
        'browser_hover',
        'browser_press',
        'browser_drag',
        'browser_viewport',
        'browser_console',
        'browser_network',
      ];
      for (const name of devtoolsParityTools) {
        if (selection.enabled.some((pattern) => matches(pattern, name))) continue;
        if (selection.enabled.length >= MAX_AGENT_TOOLS) break;
        selection.enabled.push(name);
      }
    }
    const migrated = normalizeSelection(selection);
    try {
      db.transaction(() => {
        db.setSetting(SETTING_KEY, migrated);
        db.setSetting(SETTING_VERSION_KEY, SETTING_VERSION);
        // Also upgrade existing main-default profile in studio.agent.toolProfiles.v1 if present.
        if (version < 8) {
          const store = db.getSetting(TOOL_PROFILES_KEY, null);
          const mainProfile = store?.profiles?.[MAIN_DEFAULT_PROFILE_ID];
          if (mainProfile && Array.isArray(mainProfile.enabled) && mainProfile.enabled.some((pattern) => matches(pattern, 'browser_open'))) {
            let changed = false;
            const nextEnabled = [...mainProfile.enabled];
            for (const name of ['browser_hover', 'browser_press', 'browser_drag', 'browser_viewport', 'browser_console', 'browser_network']) {
              if (nextEnabled.some((pattern) => matches(pattern, name))) continue;
              if (nextEnabled.length >= MAX_AGENT_TOOLS) break;
              nextEnabled.push(name);
              changed = true;
            }
            if (changed) {
              db.setSetting(TOOL_PROFILES_KEY, {
                ...store,
                profiles: {
                  ...store.profiles,
                  [MAIN_DEFAULT_PROFILE_ID]: { ...mainProfile, enabled: nextEnabled },
                },
              });
            }
          }
        }
      });
    } catch {
      // Next read retries idempotent migration.
    }
    return migrated;
  }
  return selection;
}

function mcpRulesFrom(selection) {
  return selection.enabled.filter((name) => name.startsWith('mcp__') || name.includes('*'));
}

function saveInstalledToolSelection(input, db = getStudioDatabase(), { inTransaction = false, syncProfiles = true } = {}) {
  const selection = normalizeSelection(input, true);
  // Old callers may echo a mixed snapshot. Only the local part belongs to this editor.
  const enabled = selection.enabled.filter((name) => !name.startsWith('mcp__'));
  const next = { enabled, sources: normalizeSources(selection.sources, enabled) };
  const inherited = db.getSetting(MCP_RULES_KEY, null) === null ? mcpRulesFrom(readAgentToolSelection(db)) : null;
  const write = () => {
    if (inherited !== null) db.setSetting(MCP_RULES_KEY, inherited);
    db.setSetting(SETTING_KEY, next);
    db.setSetting(SETTING_VERSION_KEY, SETTING_VERSION);
    if (syncProfiles && Object.hasOwn(db.getSettings(), TOOL_PROFILES_KEY)) {
      const store = readToolProfilesStore(db);
      const targetId = store.mainProfileId;
      if (Object.hasOwn(store.profiles, targetId)) {
        store.profiles[targetId] = {
          ...store.profiles[targetId],
          enabled: [...next.enabled],
          sources: clone(next.sources),
        };
        db.setSetting(TOOL_PROFILES_KEY, store);
      }
    }
  };
  if (inTransaction) write();
  else db.transaction(write);
  return next;
}

function defaultMainToolProfile(legacy = { enabled: DEFAULT_AGENT_TOOLS.filter((n) => !n.startsWith('mcp__')), sources: {} }) {
  const localEnabled = (legacy.enabled || []).filter((name) => !name.startsWith('mcp__'));
  return {
    id: MAIN_DEFAULT_PROFILE_ID,
    name: '主对话默认工具',
    description: '包含编码、文件系统、浏览器与已启用的扩展及 MCP 工具。',
    builtin: true,
    icon: null,
    enabled: localEnabled,
    sources: normalizeSources(legacy.sources, localEnabled),
    extensionMode: 'all-enabled',
    mcpMode: 'follow-server',
    mcpServers: [],
  };
}

function defaultTemporaryToolProfile() {
  return {
    id: TEMPORARY_DEFAULT_PROFILE_ID,
    name: '临时对话默认工具',
    description: '默认不启用任何工具（纯对话）；可按需勾选内置工具、安全扩展或指定 MCP 服务。',
    builtin: true,
    icon: null,
    enabled: [],
    sources: {},
    extensionMode: 'safe-only',
    mcpMode: 'none',
    mcpServers: [],
  };
}

function normalizeMcpServerList(value, strict = false) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    if (strict) throw new Error('MCP 服务器列表格式无效');
    return [];
  }
  const seen = new Set();
  const list = [];
  for (const raw of value) {
    if (list.length >= MAX_MCP_SERVERS) break;
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || RESERVED.has(name) || name.length > 64) {
      if (strict) throw new Error(`MCP 服务器名称无效：${String(raw)}`);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    list.push(name);
  }
  return list;
}

function normalizeToolProfile(value, fallback, { strict = false } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const base = fallback || defaultMainToolProfile();
  const id = typeof source.id === 'string' && PROFILE_ID_PATTERN.test(source.id) && !RESERVED.has(source.id)
    ? source.id
    : base.id;
  const name = typeof source.name === 'string' && source.name.trim()
    ? source.name.trim().slice(0, 80)
    : base.name;
  const description = typeof source.description === 'string'
    ? source.description.trim().slice(0, 240)
    : base.description || '';
  const enabledInput = source.enabled === undefined ? base.enabled : source.enabled;
  const enabled = normalizeNames(enabledInput, strict, base.enabled)
    .filter((tool) => !tool.startsWith('mcp__'));
  const sources = normalizeSources(
    source.sources === undefined ? base.sources : source.sources,
    enabled,
  );
  const extensionMode = EXTENSION_MODES.has(source.extensionMode)
    ? source.extensionMode
    : strict && source.extensionMode !== undefined
      ? (() => { throw new Error('扩展工具策略无效'); })()
      : (base.extensionMode || 'all-enabled');
  const mcpMode = MCP_MODES.has(source.mcpMode)
    ? source.mcpMode
    : strict && source.mcpMode !== undefined
      ? (() => { throw new Error('MCP 工具策略无效'); })()
      : (base.mcpMode || 'follow-server');
  const mcpServers = normalizeMcpServerList(
    source.mcpServers === undefined ? base.mcpServers : source.mcpServers,
    strict,
  );
  return {
    id,
    name,
    description,
    builtin: id === MAIN_DEFAULT_PROFILE_ID || id === TEMPORARY_DEFAULT_PROFILE_ID,
    icon: normalizeProfileIcon(source.icon === undefined ? base.icon : source.icon),
    enabled,
    sources,
    extensionMode,
    mcpMode,
    mcpServers,
  };
}

function canonicalWorkspace(value) {
  const cwd = typeof value === 'string' ? value.trim() : '';
  return cwd && path.isAbsolute(cwd) ? path.resolve(cwd) : '';
}

function readToolProfilesStore(db = getStudioDatabase()) {
  const legacy = readAgentToolSelection(db);
  const defaultMain = defaultMainToolProfile(legacy);
  const defaultTemp = defaultTemporaryToolProfile();
  const raw = db.getSetting(TOOL_PROFILES_KEY, undefined);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      version: 1,
      mainProfileId: MAIN_DEFAULT_PROFILE_ID,
      workspaceProfiles: {},
      temporaryProfileId: TEMPORARY_DEFAULT_PROFILE_ID,
      profiles: {
        [MAIN_DEFAULT_PROFILE_ID]: defaultMain,
        [TEMPORARY_DEFAULT_PROFILE_ID]: defaultTemp,
      },
    };
  }

  const rawProfiles = raw.profiles && typeof raw.profiles === 'object' && !Array.isArray(raw.profiles)
    ? raw.profiles
    : {};
  const profiles = {
    [MAIN_DEFAULT_PROFILE_ID]: normalizeToolProfile(rawProfiles[MAIN_DEFAULT_PROFILE_ID], defaultMain),
    [TEMPORARY_DEFAULT_PROFILE_ID]: normalizeToolProfile(rawProfiles[TEMPORARY_DEFAULT_PROFILE_ID], defaultTemp),
  };
  for (const [id, entry] of Object.entries(rawProfiles)) {
    if (Object.keys(profiles).length >= MAX_TOOL_PROFILES) break;
    if (
      !PROFILE_ID_PATTERN.test(id)
      || RESERVED.has(id)
      || id === MAIN_DEFAULT_PROFILE_ID
      || id === TEMPORARY_DEFAULT_PROFILE_ID
    ) continue;
    profiles[id] = {
      ...normalizeToolProfile({ ...(entry || {}), id }, {
        ...defaultMainToolProfile({ enabled: [], sources: {} }),
        id,
        name: id,
        description: '',
        builtin: false,
      }),
      builtin: false,
    };
  }

  const workspaceProfiles = {};
  if (raw.workspaceProfiles && typeof raw.workspaceProfiles === 'object' && !Array.isArray(raw.workspaceProfiles)) {
    for (const [rawCwd, profileId] of Object.entries(raw.workspaceProfiles)) {
      if (RESERVED.has(rawCwd)) continue;
      const cwd = canonicalWorkspace(rawCwd);
      if (!cwd || typeof profileId !== 'string' || !Object.hasOwn(profiles, profileId)) continue;
      workspaceProfiles[cwd] = profileId;
    }
  }

  const mainProfileId = typeof raw.mainProfileId === 'string' && Object.hasOwn(profiles, raw.mainProfileId)
    ? raw.mainProfileId
    : MAIN_DEFAULT_PROFILE_ID;
  const temporaryProfileId = typeof raw.temporaryProfileId === 'string' && Object.hasOwn(profiles, raw.temporaryProfileId)
    ? raw.temporaryProfileId
    : TEMPORARY_DEFAULT_PROFILE_ID;

  return {
    version: 1,
    mainProfileId,
    workspaceProfiles,
    temporaryProfileId,
    profiles,
  };
}

function getToolProfilesSnapshot(cwd = '', db = getStudioDatabase()) {
  const store = readToolProfilesStore(db);
  const workspace = canonicalWorkspace(cwd);
  const workspaceProfileId = workspace ? store.workspaceProfiles[workspace] || '' : '';
  const activeMainProfileId = workspaceProfileId || store.mainProfileId;
  return {
    version: store.version,
    mainProfileId: store.mainProfileId,
    workspaceProfileId,
    activeMainProfileId,
    temporaryProfileId: store.temporaryProfileId,
    profiles: Object.values(store.profiles)
      .sort((left, right) => Number(right.builtin) - Number(left.builtin) || left.name.localeCompare(right.name))
      .map(clone),
    storage: `SQLite · ${TOOL_PROFILES_KEY}`,
  };
}

function resolveMainToolProfile(cwd = '', db = getStudioDatabase()) {
  const store = readToolProfilesStore(db);
  const workspace = canonicalWorkspace(cwd);
  const id = (workspace && store.workspaceProfiles[workspace]) || store.mainProfileId;
  return clone(store.profiles[id] || store.profiles[MAIN_DEFAULT_PROFILE_ID]);
}

function resolveTemporaryToolProfile(db = getStudioDatabase()) {
  const store = readToolProfilesStore(db);
  return clone(store.profiles[store.temporaryProfileId] || store.profiles[TEMPORARY_DEFAULT_PROFILE_ID]);
}

function syncLegacySelectionFromStore(store, db) {
  const mainProfile = store.profiles[store.mainProfileId] || store.profiles[MAIN_DEFAULT_PROFILE_ID];
  if (!mainProfile) return;
  saveInstalledToolSelection({
    enabled: mainProfile.enabled,
    sources: mainProfile.sources,
  }, db, { inTransaction: true, syncProfiles: false });
}

function saveToolProfile(input = {}, db = getStudioDatabase()) {
  const payload = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const source = payload.profile && typeof payload.profile === 'object' && !Array.isArray(payload.profile)
    ? payload.profile
    : payload;
  return db.transaction(() => {
    const store = readToolProfilesStore(db);
    const id = typeof source.id === 'string' ? source.id.trim() : store.mainProfileId;
    if (!PROFILE_ID_PATTERN.test(id) || RESERVED.has(id)) {
      throw new Error('工具方案 ID 需要 2–64 个小写字母、数字、点、横线或下划线');
    }
    const exists = Object.hasOwn(store.profiles, id);
    if (payload.mode === 'create' && exists) throw new Error('这个工具方案 ID 已存在，请使用其他 ID。');
    if (payload.mode === 'edit' && !exists) throw new Error('这份工具方案已被删除。');
    if (!exists && Object.keys(store.profiles).length >= MAX_TOOL_PROFILES) {
      throw new Error(`最多保存 ${MAX_TOOL_PROFILES} 个工具方案`);
    }
    const fallback = store.profiles[id] || {
      ...defaultMainToolProfile({ enabled: [], sources: {} }),
      id,
      name: id,
      description: '',
      builtin: false,
    };
    const next = normalizeToolProfile({ ...fallback, ...source, id }, fallback, { strict: true });
    if (id !== MAIN_DEFAULT_PROFILE_ID && id !== TEMPORARY_DEFAULT_PROFILE_ID) {
      next.builtin = false;
    }
    store.profiles[id] = next;
    db.setSetting(TOOL_PROFILES_KEY, store);
    if (id === store.mainProfileId && (source.enabled !== undefined || source.sources !== undefined)) {
      syncLegacySelectionFromStore(store, db);
    }
    return getToolProfilesSnapshot(payload.cwd, db);
  });
}

function selectToolProfile(payload = {}, db = getStudioDatabase()) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const scope = input.scope;
  if (!['global', 'workspace', 'inherit', 'temporary'].includes(scope)) {
    throw new Error('工具方案应用范围无效');
  }
  const workspace = canonicalWorkspace(input.cwd);
  if ((scope === 'workspace' || scope === 'inherit') && !workspace) {
    throw new Error('工作区范围需要有效的工作区路径');
  }
  return db.transaction(() => {
    const store = readToolProfilesStore(db);
    if (scope === 'inherit') {
      delete store.workspaceProfiles[workspace];
      db.setSetting(TOOL_PROFILES_KEY, store);
      return getToolProfilesSnapshot(workspace, db);
    }
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!PROFILE_ID_PATTERN.test(id) || !Object.hasOwn(store.profiles, id)) {
      throw new Error('指定的工具方案不存在');
    }
    if (scope === 'temporary') {
      store.temporaryProfileId = id;
    } else if (scope === 'workspace') {
      store.workspaceProfiles[workspace] = id;
    } else {
      store.mainProfileId = id;
      syncLegacySelectionFromStore(store, db);
    }
    db.setSetting(TOOL_PROFILES_KEY, store);
    return getToolProfilesSnapshot(scope === 'global' ? '' : workspace || input.cwd, db);
  });
}

function resetToolProfile(payload = {}, db = getStudioDatabase()) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const id = typeof input.id === 'string' ? input.id.trim() : MAIN_DEFAULT_PROFILE_ID;
  return db.transaction(() => {
    const store = readToolProfilesStore(db);
    if (!Object.hasOwn(store.profiles, id)) throw new Error('指定的工具方案不存在');
    const current = store.profiles[id];
    const baseline = id === TEMPORARY_DEFAULT_PROFILE_ID
      ? defaultTemporaryToolProfile()
      : defaultMainToolProfile();
    store.profiles[id] = {
      ...baseline,
      id,
      name: current.builtin ? baseline.name : current.name,
      builtin: current.builtin,
      icon: current.icon,
    };
    db.setSetting(TOOL_PROFILES_KEY, store);
    if (id === store.mainProfileId) syncLegacySelectionFromStore(store, db);
    return getToolProfilesSnapshot(input.cwd, db);
  });
}

function deleteToolProfile(payload = {}, db = getStudioDatabase()) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (id === MAIN_DEFAULT_PROFILE_ID || id === TEMPORARY_DEFAULT_PROFILE_ID) {
    throw new Error('内置默认工具方案不能删除');
  }
  return db.transaction(() => {
    const store = readToolProfilesStore(db);
    if (!PROFILE_ID_PATTERN.test(id) || !Object.hasOwn(store.profiles, id)) {
      throw new Error('指定的工具方案不存在');
    }
    delete store.profiles[id];
    for (const [cwd, profileId] of Object.entries(store.workspaceProfiles)) {
      if (profileId === id) delete store.workspaceProfiles[cwd];
    }
    if (store.mainProfileId === id) {
      store.mainProfileId = MAIN_DEFAULT_PROFILE_ID;
      syncLegacySelectionFromStore(store, db);
    }
    if (store.temporaryProfileId === id) {
      store.temporaryProfileId = TEMPORARY_DEFAULT_PROFILE_ID;
    }
    db.setSetting(TOOL_PROFILES_KEY, store);
    return getToolProfilesSnapshot(input.cwd, db);
  });
}

function deleteWorkspaceToolProfile(cwd, db = getStudioDatabase()) {
  const workspace = canonicalWorkspace(cwd);
  if (!workspace) return false;
  if (!Object.hasOwn(db.getSettings(), TOOL_PROFILES_KEY)) return false;
  const store = readToolProfilesStore(db);
  if (!Object.hasOwn(store.workspaceProfiles, workspace)) return false;
  delete store.workspaceProfiles[workspace];
  db.setSetting(TOOL_PROFILES_KEY, store);
  return true;
}

module.exports = {
  DEFAULT_AGENT_TOOLS,
  MAIN_DEFAULT_PROFILE_ID,
  MCP_RULES_KEY,
  SETTING_KEY,
  SETTING_VERSION,
  SETTING_VERSION_KEY,
  TEMPORARY_DEFAULT_PROFILE_ID,
  TOOL_PROFILES_KEY,
  deleteToolProfile,
  deleteWorkspaceToolProfile,
  getToolProfilesSnapshot,
  isValidToolName,
  matches,
  mcpRulesFrom,
  normalizeSelection,
  normalizeToolProfile,
  readAgentToolSelection,
  readToolProfilesStore,
  resetToolProfile,
  resolveMainToolProfile,
  resolveTemporaryToolProfile,
  saveInstalledToolSelection,
  saveToolProfile,
  selectToolProfile,
};
