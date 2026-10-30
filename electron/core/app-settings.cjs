/**
 * Typed accessors for Studio's application-level preferences.
 *
 * Theme, palette, menu-bar visibility, permission mode, and subagent defaults
 * all live in the same SQLite `settings` table as the rest of Studio.
 */

const path = require('node:path');
const { getStudioDatabase } = require('./studio-db.cjs');
const {
  globalInstructionFile,
  globalInstructionStatus,
} = require('./studio-paths.cjs');
const {
  defaultPolicy: defaultPermissionPolicy,
  normalizePolicy: normalizePermissionPolicy,
  normalizePolicyStore: normalizePermissionStore,
  presetDefault: permissionPresetDefault,
} = require('../services/permission-policy.cjs');

const KEYS = Object.freeze({
  theme: 'studio.app.theme',
  palette: 'studio.app.palette',
  menuBarEnabled: 'studio.app.menuBarEnabled',
  permissionMode: 'studio.permissions.mode',
  permissionPolicy: 'studio.permissions.policy',
  subagents: 'studio.subagents',
  harness: 'studio.harness',
  runtimePolicy: 'studio.runtime.policy',
  extensionRegistryUrl: 'studio.extensions.registryUrl',
  conversationExtensionUi: 'studio.extensions.conversationUi',
});

const THEMES = new Set(['light', 'dark', 'system']);
const PALETTES = new Set(['lime', 'ocean', 'amber', 'berry']);
const PERMISSION_MODES = new Set(['ask', 'smart', 'full']);
const TOOL_EXECUTION_MODES = new Set(['parallel', 'sequential']);
const HARNESS_PROFILE_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const RESERVED_HARNESS_PROFILE_IDS = new Set(['constructor', 'prototype']);
const MAX_HARNESS_PROFILES = 16;
const MAX_HARNESS_INSTRUCTIONS = 64 * 1024;
const MAX_HARNESS_SECTION_OVERRIDE = 32 * 1024;
const MAX_TOOL_GUIDANCE_ENTRIES = 64;
const TOOL_GUIDANCE_NAME = /^[A-Za-z0-9_.:-]{1,120}$/;
const HARNESS_SECTIONS = Object.freeze([
  {
    id: 'preamble',
    label: '编码身份',
    description: '声明 Pi Studio 的编码 Agent 身份、工作方式和完成标准。',
  },
  {
    id: 'tools',
    label: '工具策略',
    description: '根据本次请求实际开放的工具体系注入使用策略。',
  },
  {
    id: 'rules',
    label: '编码规则',
    description: '约束代码检查、最小修改、验证和安全边界。',
  },
  {
    id: 'repositoryDocs',
    label: '仓库文档',
    description: '列出工作区内可用的说明文档，提醒优先读取事实来源。',
  },
  {
    id: 'projectContext',
    label: '项目指令',
    description: '先加载应用级 AGENTS.md，再从最近的 Git 或 Studio 项目边界加载到当前目录。',
  },
  {
    id: 'skills',
    label: '技能',
    description: '注入 Studio 用户级和项目级 SKILL.md。',
  },
  {
    id: 'cwd',
    label: '工作区',
    description: '告知模型当前主工作目录。',
  },
  {
    id: 'addendum',
    label: '自定义补充',
    description: '注入当前 profile 的自定义 harness 指令。',
  },
]);
const HARNESS_SECTION_IDS = Object.freeze(HARNESS_SECTIONS.map((section) => section.id));
const DEFAULT_HARNESS_SECTIONS = Object.freeze(Object.fromEntries(
  HARNESS_SECTION_IDS.map((id) => [id, true]),
));
const DEFAULT_HARNESS_PROFILE = Object.freeze({
  id: 'studio-coding',
  name: 'Studio 编码基线',
  builtin: true,
  sections: DEFAULT_HARNESS_SECTIONS,
  sectionOverrides: {},
  customInstructions: '',
  toolGuidance: {},
});
const RUNTIME_POLICY_DEFAULTS = Object.freeze({
  version: 1,
  streamTimeoutMs: 0,
  retry: Object.freeze({
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2_000,
  }),
  compaction: Object.freeze({
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    backgroundTokens: 32_768,
  }),
  toolExecution: 'parallel',
  afterFailedRun: 'keep',
  restartLimit: 5,
  longTask: Object.freeze({
    maxContinuations: 32,
    maxStalledContinuations: 3,
  }),
  contextRetentionMs: 90_000,
  documentRetentionMs: 90_000,
});
const AFTER_FAILED_RUN_MODES = new Set(['keep', 'continue', 'withdraw']);
const MAX_SESSION_POLICY_ID = 256;
const MAX_EXTENSION_ORDER = 256;
const MAX_EXTENSION_SESSION_ORDERS = 512;
const EXTENSION_ORDER_ID = /^(?:builtin|user|project):[a-z0-9][a-z0-9._-]{1,63}$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeHarnessSections(value, fallback = DEFAULT_HARNESS_SECTIONS) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(HARNESS_SECTION_IDS.map((id) => [
    id,
    source[id] === undefined ? fallback[id] !== false : source[id] === true,
  ]));
}

function normalizeToolGuidance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .flatMap(([name, guidance]) => {
      const clean = typeof guidance === 'string' ? guidance.trim().slice(0, 1_200) : '';
      return TOOL_GUIDANCE_NAME.test(name) && clean ? [[name, clean]] : [];
    })
    .slice(0, MAX_TOOL_GUIDANCE_ENTRIES));
}

function normalizeSectionOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(HARNESS_SECTION_IDS.flatMap((id) => {
    const text = typeof value[id] === 'string'
      ? value[id].slice(0, MAX_HARNESS_SECTION_OVERRIDE)
      : '';
    return text.trim() ? [[id, text]] : [];
  }));
}

function normalizeHarnessProfile(value, fallback) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fallbackProfile = fallback || DEFAULT_HARNESS_PROFILE;
  const id = typeof source.id === 'string' && HARNESS_PROFILE_ID.test(source.id)
    ? source.id
    : fallbackProfile.id;
  const name = typeof source.name === 'string' && source.name.trim()
    ? source.name.trim().slice(0, 80)
    : fallbackProfile.name;
  const customInstructions = typeof source.customInstructions === 'string'
    ? source.customInstructions.slice(0, MAX_HARNESS_INSTRUCTIONS)
    : fallbackProfile.customInstructions;
  return {
    id,
    name,
    builtin: id === DEFAULT_HARNESS_PROFILE.id,
    sections: normalizeHarnessSections(source.sections, fallbackProfile.sections),
    sectionOverrides: normalizeSectionOverrides(
      source.sectionOverrides === undefined
        ? fallbackProfile.sectionOverrides
        : source.sectionOverrides,
    ),
    customInstructions,
    toolGuidance: normalizeToolGuidance(
      source.toolGuidance === undefined ? fallbackProfile.toolGuidance : source.toolGuidance,
    ),
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, Math.trunc(number)))
    : fallback;
}

function normalizeRuntimePolicy(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const retry = source.retry && typeof source.retry === 'object' && !Array.isArray(source.retry)
    ? source.retry
    : {};
  const compaction = source.compaction
    && typeof source.compaction === 'object'
    && !Array.isArray(source.compaction)
    ? source.compaction
    : {};
  const longTask = source.longTask
    && typeof source.longTask === 'object'
    && !Array.isArray(source.longTask)
    ? source.longTask
    : {};
  const defaults = RUNTIME_POLICY_DEFAULTS;
  return {
    version: 1,
    streamTimeoutMs: boundedInteger(
      source.streamTimeoutMs,
      defaults.streamTimeoutMs,
      0,
      30 * 60_000,
    ),
    retry: {
      enabled: typeof retry.enabled === 'boolean' ? retry.enabled : defaults.retry.enabled,
      maxRetries: boundedInteger(retry.maxRetries, defaults.retry.maxRetries, 0, 10),
      baseDelayMs: boundedInteger(
        retry.baseDelayMs,
        defaults.retry.baseDelayMs,
        100,
        60_000,
      ),
    },
    compaction: {
      enabled: typeof compaction.enabled === 'boolean'
        ? compaction.enabled
        : defaults.compaction.enabled,
      reserveTokens: boundedInteger(
        compaction.reserveTokens,
        defaults.compaction.reserveTokens,
        1_024,
        262_144,
      ),
      keepRecentTokens: boundedInteger(
        compaction.keepRecentTokens,
        defaults.compaction.keepRecentTokens,
        0,
        262_144,
      ),
      backgroundTokens: boundedInteger(
        compaction.backgroundTokens,
        defaults.compaction.backgroundTokens,
        0,
        262_144,
      ),
    },
    toolExecution: TOOL_EXECUTION_MODES.has(source.toolExecution)
      ? source.toolExecution
      : defaults.toolExecution,
    afterFailedRun: AFTER_FAILED_RUN_MODES.has(source.afterFailedRun)
      ? source.afterFailedRun
      : defaults.afterFailedRun,
    restartLimit: boundedInteger(source.restartLimit, defaults.restartLimit, 1, 50),
    longTask: {
      maxContinuations: boundedInteger(
        longTask.maxContinuations,
        defaults.longTask.maxContinuations,
        1,
        500,
      ),
      maxStalledContinuations: boundedInteger(
        longTask.maxStalledContinuations,
        defaults.longTask.maxStalledContinuations,
        1,
        50,
      ),
    },
    contextRetentionMs: boundedInteger(
      source.contextRetentionMs,
      defaults.contextRetentionMs,
      0,
      3_600_000,
    ),
    documentRetentionMs: boundedInteger(
      source.documentRetentionMs,
      defaults.documentRetentionMs,
      0,
      3_600_000,
    ),
  };
}

function getRuntimePolicy() {
  return normalizeRuntimePolicy(
    getStudioDatabase().getSetting(KEYS.runtimePolicy, RUNTIME_POLICY_DEFAULTS),
  );
}

function saveRuntimePolicy(value) {
  const next = normalizeRuntimePolicy(value);
  getStudioDatabase().setSetting(KEYS.runtimePolicy, next);
  return next;
}

function normalizeExtensionOrder(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const output = [];
  for (const item of value) {
    if (output.length >= MAX_EXTENSION_ORDER || typeof item !== 'string') continue;
    const id = item.trim();
    if (!EXTENSION_ORDER_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  return output;
}

function normalizeConversationExtensionUiPreferences(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sessionOrders = {};
  const rawSessions = source.sessionOrders
    && typeof source.sessionOrders === 'object'
    && !Array.isArray(source.sessionOrders)
    ? Object.entries(source.sessionOrders)
    : [];
  for (const [rawSessionId, rawOrder] of rawSessions) {
    if (Object.keys(sessionOrders).length >= MAX_EXTENSION_SESSION_ORDERS) break;
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
    if (!sessionId || sessionId.length > MAX_SESSION_POLICY_ID || !Array.isArray(rawOrder)) continue;
    const order = normalizeExtensionOrder(rawOrder);
    if (order.length > 0) sessionOrders[sessionId] = order;
  }
  return {
    version: 1,
    layout: source.layout === 'list' ? 'list' : 'grid',
    globalOrder: normalizeExtensionOrder(source.globalOrder),
    sessionOrders,
  };
}

function getConversationExtensionUiPreferences() {
  return normalizeConversationExtensionUiPreferences(
    getStudioDatabase().getSetting(KEYS.conversationExtensionUi, {}),
  );
}

/**
 * Persist the global extension order/layout and optional per-conversation
 * overrides. Passing `sessionOrder: null` removes one override.
 */
function saveConversationExtensionUiPreferences(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const current = getConversationExtensionUiPreferences();
  const next = {
    ...current,
    sessionOrders: { ...current.sessionOrders },
  };
  if (source.layout === 'grid' || source.layout === 'list') next.layout = source.layout;
  if (Array.isArray(source.globalOrder)) {
    next.globalOrder = normalizeExtensionOrder(source.globalOrder);
  }
  const sessionId = typeof source.sessionId === 'string' ? source.sessionId.trim() : '';
  if (sessionId && sessionId.length <= MAX_SESSION_POLICY_ID && Object.hasOwn(source, 'sessionOrder')) {
    if (source.sessionOrder === null) {
      delete next.sessionOrders[sessionId];
    } else {
      const order = normalizeExtensionOrder(source.sessionOrder);
      if (order.length > 0) next.sessionOrders[sessionId] = order;
      else delete next.sessionOrders[sessionId];
    }
  }
  while (Object.keys(next.sessionOrders).length > MAX_EXTENSION_SESSION_ORDERS) {
    delete next.sessionOrders[Object.keys(next.sessionOrders)[0]];
  }
  const normalized = normalizeConversationExtensionUiPreferences(next);
  getStudioDatabase().setSetting(KEYS.conversationExtensionUi, normalized);
  return normalized;
}

function defaultHarnessStore() {
  return {
    version: 1,
    activeProfileId: DEFAULT_HARNESS_PROFILE.id,
    workspaceProfiles: {},
    profiles: {
      [DEFAULT_HARNESS_PROFILE.id]: clone(DEFAULT_HARNESS_PROFILE),
    },
  };
}

function normalizeHarnessStore(value) {
  const fallback = defaultHarnessStore();
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const profiles = {};
  const rawProfiles = source.profiles && typeof source.profiles === 'object' && !Array.isArray(source.profiles)
    ? source.profiles
    : {};
  profiles[DEFAULT_HARNESS_PROFILE.id] = normalizeHarnessProfile(
    rawProfiles[DEFAULT_HARNESS_PROFILE.id],
    DEFAULT_HARNESS_PROFILE,
  );
  for (const [id, profile] of Object.entries(rawProfiles)) {
    if (Object.keys(profiles).length >= MAX_HARNESS_PROFILES) break;
    if (!HARNESS_PROFILE_ID.test(id) || RESERVED_HARNESS_PROFILE_IDS.has(id) || id === DEFAULT_HARNESS_PROFILE.id) continue;
    const normalized = normalizeHarnessProfile({ ...(profile || {}), id }, {
      ...DEFAULT_HARNESS_PROFILE,
      id,
      name: id,
      builtin: false,
      customInstructions: '',
    });
    profiles[id] = { ...normalized, builtin: false };
  }
  const workspaceProfiles = {};
  if (source.workspaceProfiles && typeof source.workspaceProfiles === 'object' && !Array.isArray(source.workspaceProfiles)) {
    for (const [cwd, profileId] of Object.entries(source.workspaceProfiles)) {
      if (
        typeof cwd === 'string'
        && cwd
        && typeof profileId === 'string'
        && Object.hasOwn(profiles, profileId)
      ) {
        workspaceProfiles[cwd] = profileId;
      }
    }
  }
  const activeProfileId = typeof source.activeProfileId === 'string'
    && Object.hasOwn(profiles, source.activeProfileId)
    ? source.activeProfileId
    : fallback.activeProfileId;
  return {
    version: 1,
    activeProfileId,
    workspaceProfiles,
    profiles,
  };
}

function getTheme() {
  const value = getStudioDatabase().getSetting(KEYS.theme, 'light');
  return THEMES.has(value) ? value : 'light';
}

function getPalette() {
  const value = getStudioDatabase().getSetting(KEYS.palette, 'lime');
  return PALETTES.has(value) ? value : 'lime';
}

function getMenuBarEnabled() {
  return getStudioDatabase().getSetting(KEYS.menuBarEnabled, true) !== false;
}

function getPermissionMode() {
  return getPermissionPolicyStore().user.preset;
}

function getPermissionPolicyStore() {
  const db = getStudioDatabase();
  const legacy = db.getSetting(KEYS.permissionMode, 'smart');
  const fallbackMode = PERMISSION_MODES.has(legacy) ? legacy : 'smart';
  const stored = db.getSetting(KEYS.permissionPolicy, undefined);
  const source = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? stored
    : {};
  return normalizePermissionStore({
    version: 1,
    user: source.user || defaultPermissionPolicy(fallbackMode),
    workspaces: source.workspaces || {},
    sessions: source.sessions || {},
  });
}

function savePermissionPolicyStore(value) {
  const next = normalizePermissionStore(value, { strict: true });
  getStudioDatabase().setSetting(KEYS.permissionPolicy, next);
  return next;
}

function canonicalPermissionSessionId(value) {
  const sessionId = typeof value === 'string' ? value.trim() : '';
  if (!sessionId) return '';
  try {
    return String(getStudioDatabase().getConversation(sessionId)?.publicId || sessionId);
  } catch {
    return sessionId;
  }
}

function assertWorkspaceScope(cwd) {
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('工作区权限范围需要绝对工作区路径');
}

function assertSessionScope(sessionId) {
  if (!sessionId || sessionId.length > MAX_SESSION_POLICY_ID) {
    throw new Error('会话权限范围需要有效会话 ID');
  }
}

function setPermissionMode(mode, options = {}) {
  if (!PERMISSION_MODES.has(mode)) throw new Error('无效的权限模式');
  const scope = options.scope === 'workspace' || options.scope === 'session'
    ? options.scope
    : 'user';
  const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';
  const sessionId = canonicalPermissionSessionId(options.sessionId);
  const store = getPermissionPolicyStore();
  if (scope === 'workspace') assertWorkspaceScope(cwd);
  if (scope === 'session') assertSessionScope(sessionId);
  const current = scope === 'workspace'
    ? store.workspaces[cwd] || store.user
    : scope === 'session'
      ? store.sessions[sessionId]
        || (cwd ? store.workspaces[cwd] : undefined)
        || store.user
      : store.user;
  const nextPolicy = {
    ...current,
    preset: mode,
    default: permissionPresetDefault(mode),
  };
  if (scope === 'workspace') store.workspaces[cwd] = normalizePermissionPolicy(nextPolicy);
  else if (scope === 'session') store.sessions[sessionId] = normalizePermissionPolicy(nextPolicy);
  else store.user = normalizePermissionPolicy(nextPolicy);
  savePermissionPolicyStore(store);
  if (scope === 'user') getStudioDatabase().setSetting(KEYS.permissionMode, mode);
  return mode;
}

function setPermissionPolicy({ scope = 'user', cwd = '', sessionId = '', policy } = {}) {
  const store = getPermissionPolicyStore();
  const normalized = normalizePermissionPolicy(policy, { strict: true });
  if (scope === 'workspace') {
    assertWorkspaceScope(cwd);
    store.workspaces[cwd] = normalized;
  } else if (scope === 'session') {
    const id = canonicalPermissionSessionId(sessionId);
    assertSessionScope(id);
    store.sessions[id] = normalized;
  } else if (scope === 'user') {
    store.user = normalized;
    getStudioDatabase().setSetting(KEYS.permissionMode, normalized.preset);
  } else {
    throw new Error('无效的权限策略范围');
  }
  savePermissionPolicyStore(store);
  return normalized;
}

function resetPermissionPolicy({ scope = 'user', cwd = '', sessionId = '' } = {}) {
  const store = getPermissionPolicyStore();
  if (scope === 'workspace') {
    assertWorkspaceScope(cwd);
    delete store.workspaces[cwd];
  } else if (scope === 'session') {
    const id = canonicalPermissionSessionId(sessionId);
    assertSessionScope(id);
    delete store.sessions[id];
  } else if (scope === 'user') {
    store.user = defaultPermissionPolicy('smart');
    getStudioDatabase().setSetting(KEYS.permissionMode, 'smart');
  } else {
    throw new Error('无效的权限策略范围');
  }
  savePermissionPolicyStore(store);
  return store;
}

function deletePermissionSessionPolicy(sessionId) {
  const id = canonicalPermissionSessionId(sessionId);
  if (!id || id.length > MAX_SESSION_POLICY_ID) return false;
  const store = getPermissionPolicyStore();
  if (!Object.hasOwn(store.sessions, id)) return false;
  delete store.sessions[id];
  savePermissionPolicyStore(store);
  return true;
}

function deletePermissionPoliciesForWorkspace(cwd, sessionIds = []) {
  const workspace = typeof cwd === 'string' ? cwd.trim() : '';
  if (!workspace || !path.isAbsolute(workspace)) return false;
  const store = getPermissionPolicyStore();
  let changed = false;
  if (Object.hasOwn(store.workspaces, workspace)) {
    delete store.workspaces[workspace];
    changed = true;
  }
  for (const sessionId of sessionIds) {
    const id = canonicalPermissionSessionId(sessionId);
    if (!id || id.length > MAX_SESSION_POLICY_ID || !Object.hasOwn(store.sessions, id)) continue;
    delete store.sessions[id];
    changed = true;
  }
  if (changed) savePermissionPolicyStore(store);
  return changed;
}

/**
 * Remove every Studio preference scoped to a workspace. Project instructions,
 * skills, MCP resources, and the real folder live inside the workspace and are
 * left untouched; this clears only host-owned overrides and trust state.
 */
function deleteWorkspaceScopedSettings(cwd, sessionIds = []) {
  const workspace = typeof cwd === 'string' ? cwd.trim() : '';
  if (!workspace || !path.isAbsolute(workspace)) {
    throw new Error('工作区路径无效');
  }
  const db = getStudioDatabase();
  return db.transaction(() => {
    const permissionStore = getPermissionPolicyStore();
    delete permissionStore.workspaces[workspace];
    for (const value of sessionIds) {
      const id = canonicalPermissionSessionId(value);
      if (id && id.length <= MAX_SESSION_POLICY_ID) delete permissionStore.sessions[id];
    }
    db.setSetting(KEYS.permissionPolicy, permissionStore);

    const subagentSettings = db.getSetting(KEYS.subagents, {});
    if (subagentSettings && typeof subagentSettings === 'object' && !Array.isArray(subagentSettings)) {
      const next = {
        ...subagentSettings,
        projects: subagentSettings.projects
          && typeof subagentSettings.projects === 'object'
          && !Array.isArray(subagentSettings.projects)
          ? { ...subagentSettings.projects }
          : {},
      };
      delete next.projects[workspace];
      db.setSetting(KEYS.subagents, next);
    }

    const harnessStore = getHarnessStore();
    delete harnessStore.workspaceProfiles[workspace];
    db.setSetting(KEYS.harness, harnessStore);

    const conversationExtensions = getConversationExtensionUiPreferences();
    let extensionPreferencesChanged = false;
    for (const value of sessionIds) {
      const id = typeof value === 'string' ? value.trim() : '';
      if (!id || !Object.hasOwn(conversationExtensions.sessionOrders, id)) continue;
      delete conversationExtensions.sessionOrders[id];
      extensionPreferencesChanged = true;
    }
    if (extensionPreferencesChanged) {
      db.setSetting(KEYS.conversationExtensionUi, conversationExtensions);
    }
    return true;
  });
}

function getSubagentConfig(scope = 'user', cwd = '') {
  const settings = getStudioDatabase().getSetting(KEYS.subagents, {});
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
  if (scope === 'project') {
    const project = settings.projects && typeof settings.projects === 'object'
      ? settings.projects[cwd]
      : undefined;
    return project && typeof project === 'object' && !Array.isArray(project) ? project : {};
  }
  return settings.user && typeof settings.user === 'object' && !Array.isArray(settings.user)
    ? settings.user
    : {};
}

function setSubagentConfig(scope, cwd, value) {
  const db = getStudioDatabase();
  const settings = db.getSetting(KEYS.subagents, {});
  const next = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? {
        ...settings,
        projects: settings.projects && typeof settings.projects === 'object'
          ? { ...settings.projects }
          : {},
        user: settings.user && typeof settings.user === 'object'
          ? { ...settings.user }
          : {},
      }
    : { user: {}, projects: {} };
  if (scope === 'project') next.projects[cwd] = value;
  else next.user = value;
  db.setSetting(KEYS.subagents, next);
  return value;
}

function getHarnessStore() {
  return normalizeHarnessStore(getStudioDatabase().getSetting(KEYS.harness, defaultHarnessStore()));
}

function harnessProfileIdForWorkspace(store, cwd) {
  if (
    cwd
    && store.workspaceProfiles[cwd]
    && Object.hasOwn(store.profiles, store.workspaceProfiles[cwd])
  ) {
    return store.workspaceProfiles[cwd];
  }
  return store.activeProfileId;
}

function getHarnessProfile(cwd = '') {
  const store = getHarnessStore();
  return clone(store.profiles[harnessProfileIdForWorkspace(store, cwd)]);
}

function getHarnessSettings(cwd = '') {
  const store = getHarnessStore();
  const activeProfileId = harnessProfileIdForWorkspace(store, cwd);
  return {
    version: store.version,
    activeProfileId,
    globalProfileId: store.activeProfileId,
    workspaceProfileId: cwd ? store.workspaceProfiles[cwd] || '' : '',
    sections: clone(HARNESS_SECTIONS),
    profiles: Object.values(store.profiles)
      .sort((left, right) => Number(right.builtin) - Number(left.builtin) || left.name.localeCompare(right.name))
      .map(clone),
    activeProfile: clone(store.profiles[activeProfileId]),
    path: `SQLite · ${KEYS.harness}`,
    globalInstructionsPath: globalInstructionFile(),
    globalInstructionsStatus: globalInstructionStatus(),
    runtimePolicy: getRuntimePolicy(),
    runtimePolicyDefaults: clone(RUNTIME_POLICY_DEFAULTS),
    runtimePolicyPath: `SQLite · ${KEYS.runtimePolicy}`,
  };
}

function saveHarnessProfile(input = {}) {
  const db = getStudioDatabase();
  const store = getHarnessStore();
  const payload = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const source = payload.profile
    && typeof payload.profile === 'object'
    && !Array.isArray(payload.profile)
    ? payload.profile
    : payload;
  const requestedId = typeof source.id === 'string' ? source.id : store.activeProfileId;
  if (!HARNESS_PROFILE_ID.test(requestedId) || RESERVED_HARNESS_PROFILE_IDS.has(requestedId)) {
    throw new Error('Harness profile id 需要 2–64 个小写字母、数字、点、横线或下划线');
  }
  if (!Object.hasOwn(store.profiles, requestedId) && Object.keys(store.profiles).length >= MAX_HARNESS_PROFILES) {
    throw new Error(`最多保存 ${MAX_HARNESS_PROFILES} 个 Harness profile`);
  }
  const current = store.profiles[requestedId] || {
    ...DEFAULT_HARNESS_PROFILE,
    id: requestedId,
    name: requestedId,
    builtin: false,
    customInstructions: '',
    toolGuidance: {},
  };
  store.profiles[requestedId] = normalizeHarnessProfile({
    ...current,
    ...source,
    id: requestedId,
    builtin: requestedId === DEFAULT_HARNESS_PROFILE.id,
  }, current);
  db.setSetting(KEYS.harness, store);
  return getHarnessSettings(payload.cwd);
}

function selectHarnessProfile(payload = {}) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const id = typeof input.id === 'string' ? input.id : '';
  const store = getHarnessStore();
  if (input.scope === 'inherit') {
    if (!input.cwd) throw new Error('跟随全局需要指定工作区');
    delete store.workspaceProfiles[input.cwd];
    getStudioDatabase().setSetting(KEYS.harness, store);
    return getHarnessSettings(input.cwd);
  }
  if (!HARNESS_PROFILE_ID.test(id) || !Object.hasOwn(store.profiles, id)) {
    throw new Error('Harness profile 不存在');
  }
  const cwd = typeof input.cwd === 'string' && input.scope !== 'global' ? input.cwd : '';
  if (cwd) store.workspaceProfiles[cwd] = id;
  else store.activeProfileId = id;
  getStudioDatabase().setSetting(KEYS.harness, store);
  return getHarnessSettings(cwd);
}

function resetHarnessProfile(payload = {}) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const id = typeof input.id === 'string' ? input.id : DEFAULT_HARNESS_PROFILE.id;
  const store = getHarnessStore();
  if (!Object.hasOwn(store.profiles, id)) throw new Error('Harness profile 不存在');
  store.profiles[id] = id === DEFAULT_HARNESS_PROFILE.id
    ? clone(DEFAULT_HARNESS_PROFILE)
    : {
        ...clone(DEFAULT_HARNESS_PROFILE),
        id,
        name: store.profiles[id].name,
        builtin: false,
      };
  getStudioDatabase().setSetting(KEYS.harness, store);
  return getHarnessSettings(input.cwd);
}

function deleteHarnessProfile(payload = {}) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const id = typeof input.id === 'string' ? input.id : '';
  if (id === DEFAULT_HARNESS_PROFILE.id) throw new Error('默认 Harness profile 不能删除');
  const store = getHarnessStore();
  if (!HARNESS_PROFILE_ID.test(id) || !Object.hasOwn(store.profiles, id)) {
    throw new Error('Harness profile 不存在');
  }
  delete store.profiles[id];
  for (const [cwd, profileId] of Object.entries(store.workspaceProfiles)) {
    if (profileId === id) delete store.workspaceProfiles[cwd];
  }
  if (store.activeProfileId === id) store.activeProfileId = DEFAULT_HARNESS_PROFILE.id;
  getStudioDatabase().setSetting(KEYS.harness, store);
  return getHarnessSettings(input.cwd);
}

function getExtensionRegistryUrl() {
  const value = getStudioDatabase().getSetting(KEYS.extensionRegistryUrl);
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    return normalizeExtensionRegistryUrl(value);
  } catch {
    return '';
  }
}

function normalizeExtensionRegistryUrl(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  if (input.length > 2_048) throw new Error('Registry URL 过长');
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Registry URL 无效');
  }
  if (parsed.protocol !== 'https:' && !(
    parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
  )) {
    throw new Error('Registry URL 必须使用 HTTPS；仅本机 localhost 可使用 HTTP');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Registry URL 不能包含用户名或密码');
  }
  parsed.hash = '';
  return parsed.toString();
}

function setExtensionRegistryUrl(value) {
  const normalized = normalizeExtensionRegistryUrl(value);
  getStudioDatabase().setSetting(KEYS.extensionRegistryUrl, normalized);
  return normalized;
}

module.exports = {
  canonicalPermissionSessionId,
  DEFAULT_HARNESS_PROFILE,
  DEFAULT_HARNESS_SECTIONS,
  HARNESS_SECTION_IDS,
  HARNESS_SECTIONS,
  KEYS,
  PALETTES,
  PERMISSION_MODES,
  RUNTIME_POLICY_DEFAULTS,
  THEMES,
  defaultHarnessStore,
  deletePermissionPoliciesForWorkspace,
  deletePermissionSessionPolicy,
  deleteWorkspaceScopedSettings,
  deleteHarnessProfile,
  getHarnessProfile,
  getHarnessSettings,
  getHarnessStore,
  getConversationExtensionUiPreferences,
  getExtensionRegistryUrl,
  getMenuBarEnabled,
  getPalette,
  getPermissionMode,
  getPermissionPolicyStore,
  getRuntimePolicy,
  getSubagentConfig,
  getTheme,
  normalizeHarnessProfile,
  normalizeHarnessSections,
  normalizeHarnessStore,
  normalizeRuntimePolicy,
  normalizeSectionOverrides,
  normalizeToolGuidance,
  resetHarnessProfile,
  saveHarnessProfile,
  savePermissionPolicyStore,
  saveRuntimePolicy,
  saveConversationExtensionUiPreferences,
  selectHarnessProfile,
  setPermissionMode,
  setPermissionPolicy,
  setExtensionRegistryUrl,
  resetPermissionPolicy,
  setSubagentConfig,
};
