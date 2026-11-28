/**
 * Typed accessors for Studio's application-level preferences.
 *
 * Theme, palette, menu-bar visibility, permission mode, and subagent defaults
 * all live in the same SQLite `settings` table as the rest of Studio.
 */

const path = require('node:path');
const { normalizeProfileIcon } = require('./profile-icon.cjs');
const { getStudioDatabase } = require('./studio-db.cjs');
const { normalizeWindowBounds } = require('./window-bounds.cjs');
const {
  DEFAULT_AUTO_COMPACT_PERCENT,
  normalizeAutoCompactPercent,
} = require('./context-policy.cjs');
const {
  globalInstructionFile,
  globalInstructionStatus,
} = require('./studio-paths.cjs');
const {
  defaultPolicy: defaultPermissionPolicy,
  normalizePolicy: normalizePermissionPolicy,
  normalizePolicyStore: normalizePermissionStore,
  presetDefault: permissionPresetDefault,
} = require('./permission-policy.cjs');
const {
  THINKING_LEVELS: SUBAGENT_THINKING_LEVELS,
  normalizeConfig: normalizeSubagentConfig,
} = require('./subagent-config.cjs');
const { deleteWorkspaceToolProfile } = require('./tool-profiles.cjs');

const KEYS = Object.freeze({
  theme: 'studio.app.theme',
  windowBounds: 'studio.window.bounds',
  palette: 'studio.app.palette',
  radiusStyle: 'studio.app.radiusStyle',
  menuBarEnabled: 'studio.app.menuBarEnabled',
  permissionMode: 'studio.permissions.mode',
  permissionPolicy: 'studio.permissions.policy',
  permissionProfiles: 'studio.permissions.profiles.v1',
  subagents: 'studio.subagents',
  harness: 'studio.harness',
  runtimePolicy: 'studio.runtime.policy',
  extensionRegistryUrl: 'studio.extensions.registryUrl',
  conversationExtensionUi: 'studio.extensions.conversationUi',
});

const THEMES = new Set(['light', 'dark', 'system']);
const DEFAULT_PALETTE = 'ocean';
const PALETTES = new Set([DEFAULT_PALETTE, 'amber', 'berry']);
const RADIUS_STYLES = new Set(['square', 'compact', 'standard', 'soft']);
const RADIUS_PRESETS = Object.freeze({
  square: Object.freeze({ tag: 0, control: 0, card: 0, panel: 0, round: 0 }),
  compact: Object.freeze({ tag: 3, control: 6, card: 9, panel: 12, round: 999 }),
  standard: Object.freeze({ tag: 4, control: 8, card: 12, panel: 16, round: 999 }),
  soft: Object.freeze({ tag: 6, control: 10, card: 16, panel: 22, round: 999 }),
});
const DEFAULT_RADIUS_STYLE = 'standard';
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
  icon: null,
  sections: DEFAULT_HARNESS_SECTIONS,
  sectionOverrides: {},
  customInstructions: '',
  toolGuidance: {},
});
const TEMPORARY_HARNESS_SECTIONS = Object.freeze({
  preamble: true,
  tools: true,
  rules: false,
  repositoryDocs: false,
  projectContext: false,
  skills: false,
  cwd: false,
  addendum: true,
});
const DEFAULT_TEMPORARY_HARNESS_PROFILE = Object.freeze({
  id: 'studio-temporary',
  name: '临时对话基线',
  builtin: true,
  icon: null,
  sections: TEMPORARY_HARNESS_SECTIONS,
  sectionOverrides: {},
  customInstructions: '',
  toolGuidance: {},
});
const BUILTIN_HARNESS_PROFILES = Object.freeze({
  [DEFAULT_HARNESS_PROFILE.id]: DEFAULT_HARNESS_PROFILE,
  [DEFAULT_TEMPORARY_HARNESS_PROFILE.id]: DEFAULT_TEMPORARY_HARNESS_PROFILE,
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
    autoCompactPercent: DEFAULT_AUTO_COMPACT_PERCENT,
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
const EXTENSION_ORDER_ID = /^(?:builtin|user|project):[a-z0-9][a-z0-9._-]{1,63}$/;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SUBAGENT_MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*\/.+$/;
const SUBAGENT_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,120}$/;
const SUBAGENT_INTEGER_BOUNDS = Object.freeze({
  maxConcurrent: [1, 16],
  maxSpawns: [1, 100],
  waitTimeoutMs: [1_000, 600_000],
  worktreeLimit: [1, 50],
  budgetTokens: [0, 100_000_000],
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readSettingWithRecovery(key, fallback, normalize) {
  return getStudioDatabase().getSettingWithRecovery(key, fallback, normalize);
}

function normalizeTheme(value) {
  return THEMES.has(value) ? value : 'light';
}

function normalizePalette(value) {
  return PALETTES.has(value) ? value : DEFAULT_PALETTE;
}

function normalizeMenuBarEnabled(value) {
  return typeof value === 'boolean' ? value : true;
}

function canonicalWorkspaceKey(value) {
  const workspace = typeof value === 'string' ? value.trim() : '';
  return workspace && path.isAbsolute(workspace) ? path.resolve(workspace) : workspace;
}

function absoluteScopedEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([cwd, selected]) => (
      !RESERVED_OBJECT_KEYS.has(cwd)
      && typeof cwd === 'string'
      && path.isAbsolute(cwd)
        ? [[canonicalWorkspaceKey(cwd), selected]]
        : []
    )),
  );
}

function normalizeHarnessSections(value, fallback = DEFAULT_HARNESS_SECTIONS) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(HARNESS_SECTION_IDS.map((id) => [
    id,
    typeof source[id] === 'boolean' ? source[id] : fallback[id] !== false,
  ]));
}

function normalizeToolGuidance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .flatMap(([name, guidance]) => {
      const clean = typeof guidance === 'string' ? guidance.trim().slice(0, 1_200) : '';
      return (
        !RESERVED_OBJECT_KEYS.has(name)
        && TOOL_GUIDANCE_NAME.test(name)
        && clean
      ) ? [[name, clean]] : [];
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
  const icon = source.icon === undefined ? fallbackProfile.icon : source.icon;
  return {
    id,
    name,
    builtin: Object.hasOwn(BUILTIN_HARNESS_PROFILES, id),
    icon: normalizeProfileIcon(icon),
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
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
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
      // 百分比阈值只影响“何时自动压缩”；下面的 token 字段仍决定摘要保留量。
      autoCompactPercent: typeof compaction.autoCompactPercent === 'number'
        && Number.isFinite(compaction.autoCompactPercent)
        ? normalizeAutoCompactPercent(compaction.autoCompactPercent)
        : defaults.compaction.autoCompactPercent,
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
  return readSettingWithRecovery(
    KEYS.runtimePolicy,
    RUNTIME_POLICY_DEFAULTS,
    normalizeRuntimePolicy,
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
  return {
    version: 1,
    globalOrder: normalizeExtensionOrder(value?.globalOrder),
  };
}

function getConversationExtensionUiPreferences() {
  return readSettingWithRecovery(
    KEYS.conversationExtensionUi,
    {},
    normalizeConversationExtensionUiPreferences,
  );
}

function saveConversationExtensionUiPreferences(input) {
  if (!Array.isArray(input?.globalOrder)) return getConversationExtensionUiPreferences();
  const normalized = normalizeConversationExtensionUiPreferences(input);
  getStudioDatabase().setSetting(KEYS.conversationExtensionUi, normalized);
  return normalized;
}

function defaultHarnessStore() {
  return {
    version: 1,
    activeProfileId: DEFAULT_HARNESS_PROFILE.id,
    temporaryProfileId: DEFAULT_TEMPORARY_HARNESS_PROFILE.id,
    workspaceProfiles: {},
    profiles: {
      [DEFAULT_HARNESS_PROFILE.id]: clone(DEFAULT_HARNESS_PROFILE),
      [DEFAULT_TEMPORARY_HARNESS_PROFILE.id]: clone(DEFAULT_TEMPORARY_HARNESS_PROFILE),
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
  profiles[DEFAULT_TEMPORARY_HARNESS_PROFILE.id] = normalizeHarnessProfile(
    rawProfiles[DEFAULT_TEMPORARY_HARNESS_PROFILE.id],
    DEFAULT_TEMPORARY_HARNESS_PROFILE,
  );
  for (const [id, profile] of Object.entries(rawProfiles)) {
    if (Object.keys(profiles).length >= MAX_HARNESS_PROFILES) break;
    if (
      !HARNESS_PROFILE_ID.test(id)
      || RESERVED_HARNESS_PROFILE_IDS.has(id)
      || Object.hasOwn(BUILTIN_HARNESS_PROFILES, id)
    ) continue;
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
        && !RESERVED_OBJECT_KEYS.has(cwd)
        && path.isAbsolute(cwd)
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
  const temporaryProfileId = typeof source.temporaryProfileId === 'string'
    && Object.hasOwn(profiles, source.temporaryProfileId)
    ? source.temporaryProfileId
    : fallback.temporaryProfileId;
  return {
    version: 1,
    activeProfileId,
    temporaryProfileId,
    workspaceProfiles,
    profiles,
  };
}

function getTheme() {
  return readSettingWithRecovery(KEYS.theme, 'light', normalizeTheme);
}

function getPalette() {
  return readSettingWithRecovery(KEYS.palette, DEFAULT_PALETTE, normalizePalette);
}

function normalizeRadiusStyle(value, fallback = DEFAULT_RADIUS_STYLE) {
  return RADIUS_STYLES.has(value) ? value : fallback;
}

function getRadiusStyle() {
  return readSettingWithRecovery(
    KEYS.radiusStyle,
    DEFAULT_RADIUS_STYLE,
    normalizeRadiusStyle,
  );
}

function getRadiusPreset(style = getRadiusStyle()) {
  return { ...RADIUS_PRESETS[normalizeRadiusStyle(style)] };
}

function getMenuBarEnabled() {
  return readSettingWithRecovery(
    KEYS.menuBarEnabled,
    true,
    normalizeMenuBarEnabled,
  );
}

/** Last main-window rectangle; null until the user has moved or resized it. */
function getWindowBounds() {
  return readSettingWithRecovery(KEYS.windowBounds, null, normalizeWindowBounds);
}

function setWindowBounds(bounds) {
  const normalized = normalizeWindowBounds(bounds);
  if (!normalized) return;
  getStudioDatabase().setSetting(KEYS.windowBounds, normalized);
}

function safePermissionTools(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => !RESERVED_OBJECT_KEYS.has(name)),
  );
}

function normalizePermissionPolicySource(value, fallbackPreset) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  return {
    preset: PERMISSION_MODES.has(source.preset) ? source.preset : fallbackPreset,
    default: source.default,
    tools: safePermissionTools(source.tools),
    rules: source.rules,
  };
}

function normalizePermissionScopeMap(value, fallbackPreset, scope) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, policy]) => {
      const validId = scope === 'workspace'
        ? path.isAbsolute(id)
        : id.trim() && id.length <= MAX_SESSION_POLICY_ID;
      const normalizedId = scope === 'workspace' ? path.resolve(id) : id.trim();
      return !RESERVED_OBJECT_KEYS.has(id) && validId
        ? [[normalizedId, normalizePermissionPolicySource(policy, fallbackPreset)]]
        : [];
    }),
  );
}

function assertSafePermissionPolicy(value) {
  const tools = value && typeof value === 'object' && !Array.isArray(value)
    ? value.tools
    : undefined;
  if (tools && typeof tools === 'object' && !Array.isArray(tools)) {
    if (Object.keys(tools).some((key) => RESERVED_OBJECT_KEYS.has(key))) {
      throw new Error('工具权限不能使用原型敏感名称');
    }
  }
}

function assertSafePermissionStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  assertSafePermissionPolicy(value.user);
  for (const [scope, map] of [
    ['workspace', value.workspaces],
    ['session', value.sessions],
  ]) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [id, policy] of Object.entries(map)) {
      if (RESERVED_OBJECT_KEYS.has(id)) {
        throw new Error(`权限 ${scope} 范围不能使用原型敏感名称`);
      }
      assertSafePermissionPolicy(policy);
    }
  }
}

function getPermissionMode() {
  return getPermissionPolicyStore().user.preset;
}

function getPermissionPolicyStore() {
  const db = getStudioDatabase();
  const legacyMode = db.getSettingWithRecovery(
    KEYS.permissionMode,
    'smart',
    (value) => (PERMISSION_MODES.has(value) ? value : 'smart'),
  );
  const rawPolicy = db.getSetting(KEYS.permissionPolicy, undefined);
  const policyMode = rawPolicy
    && typeof rawPolicy === 'object'
    && !Array.isArray(rawPolicy)
    && rawPolicy.user
    && typeof rawPolicy.user === 'object'
    && !Array.isArray(rawPolicy.user)
    && PERMISSION_MODES.has(rawPolicy.user.preset)
    ? rawPolicy.user.preset
    : '';
  const fallbackMode = policyMode || legacyMode;
  const store = db.getSettingWithRecovery(
    KEYS.permissionPolicy,
    undefined,
    (value) => {
      const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
      return normalizePermissionStore({
        version: 1,
        user: normalizePermissionPolicySource(
          source.user || defaultPermissionPolicy(fallbackMode),
          fallbackMode,
        ),
        workspaces: normalizePermissionScopeMap(source.workspaces, 'smart', 'workspace'),
        sessions: normalizePermissionScopeMap(source.sessions, 'smart', 'session'),
      });
    },
  );
  if (store.user.preset !== legacyMode) {
    try {
      db.setSetting(KEYS.permissionMode, store.user.preset);
    } catch {
      // The policy remains authoritative for this read even if legacy mirrors lag.
    }
  }
  return store;
}

function savePermissionPolicyStore(value) {
  assertSafePermissionStore(value);
  const next = normalizePermissionStore(value, { strict: true });
  getStudioDatabase().setSetting(KEYS.permissionPolicy, next);
  return next;
}

const PERMISSION_PROFILE_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const MAX_PERMISSION_PROFILES = 24;
const DEFAULT_PERMISSION_PROFILE_IDS = Object.freeze({
  smart: 'smart-default',
  ask: 'strict-ask',
  full: 'full-access',
});

function builtinPermissionProfiles(userPolicy) {
  return {
    [DEFAULT_PERMISSION_PROFILE_IDS.smart]: {
      id: DEFAULT_PERMISSION_PROFILE_IDS.smart,
      name: '帮我批准（默认）',
      description: '只自动允许明确的只读工具；风险或未知工具仍会确认。',
      builtin: true,
      icon: null,
      policy: userPolicy?.preset === 'smart'
        ? normalizePermissionPolicy(userPolicy)
        : defaultPermissionPolicy('smart'),
    },
    [DEFAULT_PERMISSION_PROFILE_IDS.ask]: {
      id: DEFAULT_PERMISSION_PROFILE_IDS.ask,
      name: '严格确认',
      description: '所有工具调用逐次确认，适合临时对话或高敏感操作。',
      builtin: true,
      icon: null,
      policy: userPolicy?.preset === 'ask'
        ? normalizePermissionPolicy(userPolicy)
        : defaultPermissionPolicy('ask'),
    },
    [DEFAULT_PERMISSION_PROFILE_IDS.full]: {
      id: DEFAULT_PERMISSION_PROFILE_IDS.full,
      name: '完全权限',
      description: '普通工具直接执行，仅拦截高危命令与显式规则。',
      builtin: true,
      icon: null,
      policy: userPolicy?.preset === 'full'
        ? normalizePermissionPolicy(userPolicy)
        : defaultPermissionPolicy('full'),
    },
  };
}

function isBuiltinPermissionProfileId(id) {
  return id === DEFAULT_PERMISSION_PROFILE_IDS.smart
    || id === DEFAULT_PERMISSION_PROFILE_IDS.ask
    || id === DEFAULT_PERMISSION_PROFILE_IDS.full;
}

function normalizePermissionProfile(value, fallback, { strict = false } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const base = fallback || builtinPermissionProfiles()[DEFAULT_PERMISSION_PROFILE_IDS.smart];
  const id = typeof source.id === 'string' && PERMISSION_PROFILE_ID.test(source.id) && !RESERVED_OBJECT_KEYS.has(source.id)
    ? source.id
    : base.id;
  const name = typeof source.name === 'string' && source.name.trim()
    ? source.name.trim().slice(0, 80)
    : base.name;
  const description = typeof source.description === 'string'
    ? source.description.trim().slice(0, 240)
    : (base.description || '');
  const policySource = source.policy && typeof source.policy === 'object' && !Array.isArray(source.policy)
    ? source.policy
    : base.policy;
  const policy = normalizePermissionPolicy(policySource, { strict });
  return {
    id,
    name,
    description,
    builtin: isBuiltinPermissionProfileId(id),
    icon: normalizeProfileIcon(source.icon === undefined ? base.icon : source.icon),
    policy,
  };
}

function initialMainProfileIdForUserPolicy(policy) {
  if (policy?.preset === 'full') return DEFAULT_PERMISSION_PROFILE_IDS.full;
  if (policy?.preset === 'ask') return DEFAULT_PERMISSION_PROFILE_IDS.ask;
  return DEFAULT_PERMISSION_PROFILE_IDS.smart;
}

function getPermissionProfilesStore() {
  const db = getStudioDatabase();
  const policyStore = getPermissionPolicyStore();
  const builtins = builtinPermissionProfiles(policyStore.user);
  const raw = db.getSetting(KEYS.permissionProfiles, undefined);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      version: 1,
      mainProfileId: initialMainProfileIdForUserPolicy(policyStore.user),
      workspaceProfiles: {},
      temporaryProfileId: DEFAULT_PERMISSION_PROFILE_IDS.ask,
      profiles: builtins,
    };
  }
  const rawProfiles = raw.profiles && typeof raw.profiles === 'object' && !Array.isArray(raw.profiles)
    ? raw.profiles
    : {};
  let smartProfile = normalizePermissionProfile(
    rawProfiles[DEFAULT_PERMISSION_PROFILE_IDS.smart],
    builtins[DEFAULT_PERMISSION_PROFILE_IDS.smart],
  );
  let askProfile = normalizePermissionProfile(
    rawProfiles[DEFAULT_PERMISSION_PROFILE_IDS.ask],
    builtins[DEFAULT_PERMISSION_PROFILE_IDS.ask],
  );
  let fullProfile = normalizePermissionProfile(
    rawProfiles[DEFAULT_PERMISSION_PROFILE_IDS.full],
    builtins[DEFAULT_PERMISSION_PROFILE_IDS.full],
  );
  let migratedMainId = '';
  let needsHealPersist = false;
  // Guard against older migrations / mode-sync writes that corrupted a builtin profile's preset.
  if (smartProfile.policy.preset !== 'smart') {
    const misassignedPreset = smartProfile.policy.preset;
    migratedMainId = initialMainProfileIdForUserPolicy(smartProfile.policy);
    if (misassignedPreset === 'full' && !rawProfiles[DEFAULT_PERMISSION_PROFILE_IDS.full]) {
      fullProfile = { ...fullProfile, policy: clone(smartProfile.policy) };
    } else if (misassignedPreset === 'ask' && !rawProfiles[DEFAULT_PERMISSION_PROFILE_IDS.ask]) {
      askProfile = { ...askProfile, policy: clone(smartProfile.policy) };
    }
    smartProfile = { ...smartProfile, policy: defaultPermissionPolicy('smart') };
    needsHealPersist = true;
  }
  if (askProfile.policy.preset !== 'ask') {
    if (!migratedMainId && raw.mainProfileId === DEFAULT_PERMISSION_PROFILE_IDS.ask) {
      migratedMainId = initialMainProfileIdForUserPolicy(askProfile.policy);
    }
    askProfile = { ...askProfile, policy: defaultPermissionPolicy('ask') };
    needsHealPersist = true;
  }
  if (fullProfile.policy.preset !== 'full') {
    if (!migratedMainId && raw.mainProfileId === DEFAULT_PERMISSION_PROFILE_IDS.full) {
      migratedMainId = initialMainProfileIdForUserPolicy(fullProfile.policy);
    }
    fullProfile = { ...fullProfile, policy: defaultPermissionPolicy('full') };
    needsHealPersist = true;
  }
  const profiles = {
    [DEFAULT_PERMISSION_PROFILE_IDS.smart]: smartProfile,
    [DEFAULT_PERMISSION_PROFILE_IDS.ask]: askProfile,
    [DEFAULT_PERMISSION_PROFILE_IDS.full]: fullProfile,
  };
  for (const [id, entry] of Object.entries(rawProfiles)) {
    if (Object.keys(profiles).length >= MAX_PERMISSION_PROFILES) break;
    if (!PERMISSION_PROFILE_ID.test(id) || RESERVED_OBJECT_KEYS.has(id) || isBuiltinPermissionProfileId(id)) continue;
    profiles[id] = {
      ...normalizePermissionProfile({ ...(entry || {}), id }, {
        id,
        name: id,
        description: '',
        builtin: false,
        policy: defaultPermissionPolicy('smart'),
      }),
      builtin: false,
    };
  }
  const workspaceProfiles = {};
  if (raw.workspaceProfiles && typeof raw.workspaceProfiles === 'object' && !Array.isArray(raw.workspaceProfiles)) {
    for (const [rawCwd, profileId] of Object.entries(raw.workspaceProfiles)) {
      if (RESERVED_OBJECT_KEYS.has(rawCwd)) continue;
      const cwd = canonicalWorkspaceKey(rawCwd);
      if (!cwd || !path.isAbsolute(cwd) || typeof profileId !== 'string' || !Object.hasOwn(profiles, profileId)) continue;
      workspaceProfiles[cwd] = profileId;
    }
  }
  let mainProfileId = typeof raw.mainProfileId === 'string' && Object.hasOwn(profiles, raw.mainProfileId)
    ? raw.mainProfileId
    : initialMainProfileIdForUserPolicy(policyStore.user);
  if (migratedMainId && isBuiltinPermissionProfileId(mainProfileId)) {
    mainProfileId = migratedMainId;
  }
  const temporaryProfileId = typeof raw.temporaryProfileId === 'string' && Object.hasOwn(profiles, raw.temporaryProfileId)
    ? raw.temporaryProfileId
    : DEFAULT_PERMISSION_PROFILE_IDS.ask;
  const resolved = {
    version: 1,
    mainProfileId,
    workspaceProfiles,
    temporaryProfileId,
    profiles,
  };
  if (needsHealPersist) {
    db.setSetting(KEYS.permissionProfiles, resolved);
  }
  return resolved;
}

function getPermissionProfilesSnapshot(cwd = '') {
  const store = getPermissionProfilesStore();
  const workspace = canonicalWorkspaceKey(cwd);
  const workspaceProfileId = workspace ? store.workspaceProfiles[workspace] || '' : '';
  return {
    version: store.version,
    mainProfileId: store.mainProfileId,
    workspaceProfileId,
    activeMainProfileId: workspaceProfileId || store.mainProfileId,
    temporaryProfileId: store.temporaryProfileId,
    profiles: Object.values(store.profiles)
      .sort((left, right) => Number(right.builtin) - Number(left.builtin) || left.name.localeCompare(right.name))
      .map(clone),
    storage: `SQLite · ${KEYS.permissionProfiles}`,
  };
}

function getPermissionProfileById(id) {
  if (!id) return undefined;
  const store = getPermissionProfilesStore();
  return store.profiles[id] ? clone(store.profiles[id]) : undefined;
}

function getTemporaryPermissionPolicy() {
  const store = getPermissionProfilesStore();
  const profile = store.profiles[store.temporaryProfileId] || store.profiles[DEFAULT_PERMISSION_PROFILE_IDS.ask];
  return clone(profile.policy);
}

function syncUserPermissionProfile(policy) {
  const db = getStudioDatabase();
  if (!Object.hasOwn(db.getSettings(), KEYS.permissionProfiles)) return;
  const store = getPermissionProfilesStore();
  let targetId = store.mainProfileId;
  // Never overwrite a builtin profile with a different preset when switching quick modes;
  // switch mainProfileId to the matching builtin profile instead.
  if (isBuiltinPermissionProfileId(targetId)) {
    const matchingBuiltinId = initialMainProfileIdForUserPolicy(policy);
    if (Object.hasOwn(store.profiles, matchingBuiltinId)) {
      targetId = matchingBuiltinId;
      store.mainProfileId = matchingBuiltinId;
    }
  }
  if (Object.hasOwn(store.profiles, targetId)) {
    store.profiles[targetId] = {
      ...store.profiles[targetId],
      policy: clone(policy),
    };
    db.setSetting(KEYS.permissionProfiles, store);
  }
}

function savePermissionProfile(input = {}) {
  const db = getStudioDatabase();
  const payload = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const source = payload.profile && typeof payload.profile === 'object' && !Array.isArray(payload.profile)
    ? payload.profile
    : payload;
  return db.transaction(() => {
    const store = getPermissionProfilesStore();
    const id = typeof source.id === 'string' ? source.id.trim() : store.mainProfileId;
    if (!PERMISSION_PROFILE_ID.test(id) || RESERVED_OBJECT_KEYS.has(id)) {
      throw new Error('权限方案 ID 需要 2–64 个小写字母、数字、点、横线或下划线');
    }
    const exists = Object.hasOwn(store.profiles, id);
    if (payload.mode === 'create' && exists) throw new Error('这个权限方案 ID 已存在，请使用其他 ID。');
    if (payload.mode === 'edit' && !exists) throw new Error('这份权限方案已被删除。');
    if (!exists && Object.keys(store.profiles).length >= MAX_PERMISSION_PROFILES) {
      throw new Error(`最多保存 ${MAX_PERMISSION_PROFILES} 个权限方案`);
    }
    const fallback = store.profiles[id] || {
      id,
      name: id,
      description: '',
      builtin: false,
      policy: defaultPermissionPolicy('smart'),
    };
    assertSafePermissionPolicy(source.policy);
    const next = normalizePermissionProfile({ ...fallback, ...source, id }, fallback, { strict: true });
    if (!isBuiltinPermissionProfileId(id)) next.builtin = false;
    store.profiles[id] = next;
    db.setSetting(KEYS.permissionProfiles, store);

    if (source.policy === undefined) return getPermissionProfilesSnapshot(payload.cwd);
    const policyStore = getPermissionPolicyStore();
    let policyChanged = false;
    if (store.mainProfileId === id) {
      policyStore.user = clone(next.policy);
      db.setSetting(KEYS.permissionMode, next.policy.preset);
      policyChanged = true;
    }
    for (const [workspace, boundId] of Object.entries(store.workspaceProfiles)) {
      if (boundId === id) {
        policyStore.workspaces[workspace] = clone(next.policy);
        policyChanged = true;
      }
    }
    if (policyChanged) savePermissionPolicyStore(policyStore);
    return getPermissionProfilesSnapshot(payload.cwd);
  });
}

function selectPermissionProfile(payload = {}) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const scope = input.scope;
  if (!['global', 'workspace', 'inherit', 'temporary'].includes(scope)) {
    throw new Error('权限方案应用范围无效');
  }
  const requestedCwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  const workspace = requestedCwd && path.isAbsolute(requestedCwd) ? path.resolve(requestedCwd) : '';
  if ((scope === 'workspace' || scope === 'inherit') && !workspace) {
    throw new Error('工作区权限范围需要绝对工作区路径');
  }
  const db = getStudioDatabase();
  return db.transaction(() => {
    const store = getPermissionProfilesStore();
    const policyStore = getPermissionPolicyStore();
    if (scope === 'inherit') {
      delete store.workspaceProfiles[workspace];
      delete policyStore.workspaces[workspace];
      db.setSetting(KEYS.permissionProfiles, store);
      savePermissionPolicyStore(policyStore);
      return getPermissionProfilesSnapshot(workspace);
    }
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!PERMISSION_PROFILE_ID.test(id) || !Object.hasOwn(store.profiles, id)) {
      throw new Error('指定的权限方案不存在');
    }
    const chosen = store.profiles[id];
    if (scope === 'temporary') {
      store.temporaryProfileId = id;
    } else if (scope === 'workspace') {
      store.workspaceProfiles[workspace] = id;
      policyStore.workspaces[workspace] = clone(chosen.policy);
      savePermissionPolicyStore(policyStore);
    } else {
      store.mainProfileId = id;
      policyStore.user = clone(chosen.policy);
      db.setSetting(KEYS.permissionMode, chosen.policy.preset);
      savePermissionPolicyStore(policyStore);
    }
    db.setSetting(KEYS.permissionProfiles, store);
    return getPermissionProfilesSnapshot(scope === 'global' ? '' : workspace || requestedCwd);
  });
}

function resetPermissionProfile(payload = {}) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const id = typeof input.id === 'string' ? input.id.trim() : DEFAULT_PERMISSION_PROFILE_IDS.smart;
  const db = getStudioDatabase();
  return db.transaction(() => {
    const store = getPermissionProfilesStore();
    if (!Object.hasOwn(store.profiles, id)) throw new Error('指定的权限方案不存在');
    const current = store.profiles[id];
    const builtins = builtinPermissionProfiles();
    const baseline = builtins[id] || {
      id,
      name: current.name,
      description: '',
      builtin: false,
      policy: defaultPermissionPolicy('smart'),
    };
    store.profiles[id] = {
      ...clone(baseline),
      id,
      name: current.builtin ? baseline.name : current.name,
      builtin: current.builtin,
      icon: current.icon,
    };
    db.setSetting(KEYS.permissionProfiles, store);
    const policyStore = getPermissionPolicyStore();
    let policyChanged = false;
    if (store.mainProfileId === id) {
      policyStore.user = clone(store.profiles[id].policy);
      db.setSetting(KEYS.permissionMode, store.profiles[id].policy.preset);
      policyChanged = true;
    }
    for (const [workspace, boundId] of Object.entries(store.workspaceProfiles)) {
      if (boundId === id) {
        policyStore.workspaces[workspace] = clone(store.profiles[id].policy);
        policyChanged = true;
      }
    }
    if (policyChanged) savePermissionPolicyStore(policyStore);
    return getPermissionProfilesSnapshot(input.cwd);
  });
}

function deletePermissionProfile(payload = {}) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (isBuiltinPermissionProfileId(id)) throw new Error('内置默认权限方案不能删除');
  const db = getStudioDatabase();
  return db.transaction(() => {
    const store = getPermissionProfilesStore();
    if (!PERMISSION_PROFILE_ID.test(id) || !Object.hasOwn(store.profiles, id)) {
      throw new Error('指定的权限方案不存在');
    }
    delete store.profiles[id];
    const policyStore = getPermissionPolicyStore();
    let policyChanged = false;
    for (const [workspace, boundId] of Object.entries(store.workspaceProfiles)) {
      if (boundId === id) {
        delete store.workspaceProfiles[workspace];
        delete policyStore.workspaces[workspace];
        policyChanged = true;
      }
    }
    if (store.mainProfileId === id) {
      store.mainProfileId = DEFAULT_PERMISSION_PROFILE_IDS.smart;
      policyStore.user = clone(store.profiles[DEFAULT_PERMISSION_PROFILE_IDS.smart].policy);
      db.setSetting(KEYS.permissionMode, policyStore.user.preset);
      policyChanged = true;
    }
    if (store.temporaryProfileId === id) {
      store.temporaryProfileId = DEFAULT_PERMISSION_PROFILE_IDS.ask;
    }
    if (policyChanged) savePermissionPolicyStore(policyStore);
    db.setSetting(KEYS.permissionProfiles, store);
    return getPermissionProfilesSnapshot(input.cwd);
  });
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

function normalizeWorkspaceScope(cwd, required = false) {
  const workspace = typeof cwd === 'string' ? cwd.trim() : '';
  if (!workspace) {
    if (required) throw new Error('工作区权限范围需要绝对工作区路径');
    return '';
  }
  if (!path.isAbsolute(workspace)) {
    throw new Error('工作区权限范围需要绝对工作区路径');
  }
  return path.resolve(workspace);
}

function assertWorkspaceScope(cwd) {
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('工作区权限范围需要绝对工作区路径');
  return path.resolve(cwd);
}

function assertSessionScope(sessionId) {
  if (
    !sessionId
    || RESERVED_OBJECT_KEYS.has(sessionId)
    || sessionId.length > MAX_SESSION_POLICY_ID
  ) {
    throw new Error('会话权限范围需要有效会话 ID');
  }
}

function setPermissionMode(mode, options = {}) {
  if (!PERMISSION_MODES.has(mode)) throw new Error('无效的权限模式');
  if (
    options.scope !== undefined
    && options.scope !== 'user'
    && options.scope !== 'workspace'
    && options.scope !== 'session'
  ) {
    throw new Error('无效的权限作用域');
  }
  const scope = options.scope ?? 'user';
  const cwd = normalizeWorkspaceScope(options.cwd, scope === 'workspace');
  const sessionId = canonicalPermissionSessionId(options.sessionId);
  const store = getPermissionPolicyStore();
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
  if (scope === 'user') {
    getStudioDatabase().setSetting(KEYS.permissionMode, mode);
    syncUserPermissionProfile(store.user);
  }
  return mode;
}

function setPermissionPolicy({ scope = 'user', cwd = '', sessionId = '', policy } = {}) {
  const store = getPermissionPolicyStore();
  const normalized = normalizePermissionPolicy(policy, { strict: true });
  if (scope === 'workspace') {
    store.workspaces[assertWorkspaceScope(cwd)] = normalized;
  } else if (scope === 'session') {
    const id = canonicalPermissionSessionId(sessionId);
    assertSessionScope(id);
    store.sessions[id] = normalized;
  } else if (scope === 'user') {
    store.user = normalized;
    getStudioDatabase().setSetting(KEYS.permissionMode, normalized.preset);
    syncUserPermissionProfile(normalized);
  } else {
    throw new Error('无效的权限策略范围');
  }
  savePermissionPolicyStore(store);
  return normalized;
}

function resetPermissionPolicy({ scope = 'user', cwd = '', sessionId = '' } = {}) {
  const store = getPermissionPolicyStore();
  if (scope === 'workspace') {
    delete store.workspaces[assertWorkspaceScope(cwd)];
  } else if (scope === 'session') {
    const id = canonicalPermissionSessionId(sessionId);
    assertSessionScope(id);
    delete store.sessions[id];
  } else if (scope === 'user') {
    store.user = defaultPermissionPolicy('smart');
    getStudioDatabase().setSetting(KEYS.permissionMode, 'smart');
    syncUserPermissionProfile(store.user);
  } else {
    throw new Error('无效的权限策略范围');
  }
  savePermissionPolicyStore(store);
  return store;
}

function deletePermissionPoliciesForWorkspace(cwd, sessionIds = []) {
  let workspace;
  try {
    workspace = normalizeWorkspaceScope(cwd, true);
  } catch {
    return false;
  }
  const store = getPermissionPolicyStore();
  let changed = false;
  if (Object.hasOwn(store.workspaces, workspace)) {
    delete store.workspaces[workspace];
    changed = true;
  }
  for (const sessionId of sessionIds) {
    const id = canonicalPermissionSessionId(sessionId);
    if (
      !id
      || id.length > MAX_SESSION_POLICY_ID
      || RESERVED_OBJECT_KEYS.has(id)
      || !Object.hasOwn(store.sessions, id)
    ) continue;
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
  const workspace = normalizeWorkspaceScope(cwd, true);
  const db = getStudioDatabase();
  return db.transaction(() => {
    const permissionStore = getPermissionPolicyStore();
    delete permissionStore.workspaces[workspace];
    for (const value of sessionIds) {
      const id = canonicalPermissionSessionId(value);
      if (
        id
        && id.length <= MAX_SESSION_POLICY_ID
        && !RESERVED_OBJECT_KEYS.has(id)
      ) delete permissionStore.sessions[id];
    }
    db.setSetting(KEYS.permissionPolicy, permissionStore);

    const subagentSettings = getSubagentStore();
    const nextSubagentSettings = {
      ...subagentSettings,
      projects: { ...subagentSettings.projects },
    };
    delete nextSubagentSettings.projects[workspace];
    db.setSetting(KEYS.subagents, nextSubagentSettings);

    const harnessStore = getHarnessStore();
    delete harnessStore.workspaceProfiles[workspace];
    db.setSetting(KEYS.harness, harnessStore);

    if (Object.hasOwn(db.getSettings(), KEYS.permissionProfiles)) {
      const permProfiles = getPermissionProfilesStore();
      delete permProfiles.workspaceProfiles[workspace];
      db.setSetting(KEYS.permissionProfiles, permProfiles);
    }

    deleteWorkspaceToolProfile(workspace, db);
    return true;
  });
}

function getSubagentConfig(scope = 'user', cwd = '') {
  const settings = getSubagentStore();
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
  const user = settings.user && typeof settings.user === 'object' && !Array.isArray(settings.user)
    ? settings.user
    : {};
  if (scope === 'project') {
    const workspace = canonicalWorkspaceKey(cwd);
    const project = settings.projects && typeof settings.projects === 'object'
      ? settings.projects[workspace]
      : undefined;
    if (!project || typeof project !== 'object' || Array.isArray(project)) return {};
    if (Number(settings.version) >= 2) return project;
    // Project settings are overrides. Older builds stored a normalized copy of
    // every field, which silently froze workspace rows when the user defaults
    // changed. Treat values equal to the user row as inherited overrides.
    return Object.fromEntries(Object.entries(project).filter(([key, value]) => (
      !Object.hasOwn(user, key)
      || JSON.stringify(value) !== JSON.stringify(user[key])
    )));
  }
  return user;
}

function reconcileSubagentThinking(config) {
  const output = { ...config };
  const defaultRank = SUBAGENT_THINKING_LEVELS.indexOf(output.defaultThinking);
  const maximumRank = SUBAGENT_THINKING_LEVELS.indexOf(output.maxThinking);
  if (defaultRank > maximumRank && defaultRank >= 0 && maximumRank >= 0) {
    output.defaultThinking = output.maxThinking;
  }
  return output;
}

function validSubagentInteger(value, [minimum, maximum]) {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function normalizeSubagentOverridesV2(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value;
  const picked = {};
  if (typeof source.defaultModel === 'string') {
    const model = source.defaultModel.trim();
    if (!model || SUBAGENT_MODEL_REF.test(model)) picked.defaultModel = model;
  }
  for (const key of ['defaultThinking', 'maxThinking']) {
    if (
      typeof source[key] === 'string'
      && (source[key] === '' || SUBAGENT_THINKING_LEVELS.includes(source[key]))
    ) {
      picked[key] = source[key];
    }
  }
  if (Array.isArray(source.allowedTools)) {
    picked.allowedTools = [...new Set(source.allowedTools
      .filter((name) => typeof name === 'string')
      .map((name) => name.trim())
      .filter((name) => SUBAGENT_TOOL_NAME.test(name)))]
      .slice(0, 256);
  }
  for (const key of ['backgroundEnabled', 'supervisorEnabled']) {
    if (typeof source[key] === 'boolean') picked[key] = source[key];
  }
  if (source.defaultMode === 'foreground' || source.defaultMode === 'background') {
    picked.defaultMode = source.defaultMode;
  }
  for (const [key, bounds] of Object.entries(SUBAGENT_INTEGER_BOUNDS)) {
    if (validSubagentInteger(source[key], bounds)) picked[key] = source[key];
  }
  if (
    typeof source.worktreeIsolation === 'string'
    && ['off', 'background', 'always'].includes(source.worktreeIsolation)
  ) {
    picked.worktreeIsolation = source.worktreeIsolation;
  }
  if (typeof source.worktreeParent === 'string' && (!source.worktreeParent || path.isAbsolute(source.worktreeParent))) {
    picked.worktreeParent = source.worktreeParent ? path.resolve(source.worktreeParent) : '';
  }
  if (
    typeof source.budgetCostUsd === 'number'
    && Number.isFinite(source.budgetCostUsd)
    && source.budgetCostUsd >= 0
    && source.budgetCostUsd <= 100_000
  ) {
    picked.budgetCostUsd = source.budgetCostUsd;
  }
  if (source.budgetAction === 'warn' || source.budgetAction === 'stop') {
    picked.budgetAction = source.budgetAction;
  }

  const normalized = normalizeSubagentConfig(picked, { strict: false });
  const output = Object.fromEntries(
    Object.keys(picked).map((key) => [key, normalized[key]]),
  );
  if (
    Object.hasOwn(picked, 'defaultModel')
    && Object.hasOwn(source, 'defaultProvider')
    && typeof source.defaultProvider === 'string'
    && source.defaultProvider === normalized.defaultProvider
  ) {
    output.defaultProvider = normalized.defaultProvider;
  }
  return reconcileSubagentThinking(output);
}

function normalizeSubagentOverridesLegacy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return reconcileSubagentThinking(
    normalizeSubagentConfig(value, { strict: false }),
  );
}

function normalizeSubagentOverridesV2ForUser(value, user) {
  const overrides = normalizeSubagentOverridesV2(value);
  if (overrides.defaultThinking && overrides.maxThinking) {
    return reconcileSubagentThinking(overrides);
  }
  const effectiveDefault = Object.hasOwn(overrides, 'defaultThinking')
    ? overrides.defaultThinking
    : user.defaultThinking || '';
  const effectiveMaximum = Object.hasOwn(overrides, 'maxThinking')
    ? overrides.maxThinking
    : user.maxThinking || '';
  const defaultRank = SUBAGENT_THINKING_LEVELS.indexOf(effectiveDefault);
  const maximumRank = SUBAGENT_THINKING_LEVELS.indexOf(effectiveMaximum);
  if (defaultRank > maximumRank && defaultRank >= 0 && maximumRank >= 0) {
    if (Object.hasOwn(overrides, 'defaultThinking')) delete overrides.defaultThinking;
    else if (Object.hasOwn(overrides, 'maxThinking')) delete overrides.maxThinking;
  }
  return overrides;
}

function normalizeSubagentStore(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const version = Number(source.version) >= 2 ? 2 : 1;
  const user = source.user
    && typeof source.user === 'object'
    && !Array.isArray(source.user)
    && Object.keys(source.user).length > 0
    ? reconcileSubagentThinking(
        normalizeSubagentConfig(source.user, { strict: false }),
      )
    : {};
  const rawProjects = source.projects
    && typeof source.projects === 'object'
    && !Array.isArray(source.projects)
    ? source.projects
    : {};
  const projects = Object.fromEntries(
    Object.entries(rawProjects).flatMap(([cwd, overrides]) => {
      if (
        RESERVED_OBJECT_KEYS.has(cwd)
        || typeof cwd !== 'string'
        || !path.isAbsolute(cwd)
      ) return [];
      return [[
        path.resolve(cwd),
        version >= 2
          ? normalizeSubagentOverridesV2ForUser(overrides, user)
          : normalizeSubagentOverridesLegacy(overrides),
      ]];
    }),
  );
  return { version, user, projects };
}

function getSubagentStore() {
  return readSettingWithRecovery(
    KEYS.subagents,
    { version: 1, user: {}, projects: {} },
    normalizeSubagentStore,
  );
}

function sameSettingValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Project subagent rows store overrides only. Before the override format was
 * introduced, saves copied the complete normalized user configuration, which
 * made later user-level changes appear frozen. Only the first v2 write drops
 * inherited fields from legacy full snapshots.
 */
function cleanInheritedSubagentOverrides(projects, previousUser) {
  return Object.fromEntries(Object.entries(projects).map(([workspace, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [workspace, raw];
    const project = { ...raw };
    for (const key of Object.keys(project)) {
      if (!Object.hasOwn(previousUser, key)) continue;
      if (sameSettingValue(project[key], previousUser[key])) {
        delete project[key];
      }
    }
    return [workspace, project];
  }));
}

function setSubagentConfig(scope, cwd, value) {
  if (scope !== 'user' && scope !== 'project') throw new Error('设置范围无效');
  const workspace = scope === 'project' ? canonicalWorkspaceKey(cwd) : '';
  if (scope === 'project' && (!workspace || !path.isAbsolute(workspace))) {
    throw new Error('工作区路径无效');
  }
  const db = getStudioDatabase();
  const settings = getSubagentStore();
  const next = {
    ...settings,
    projects: { ...settings.projects },
    user: { ...settings.user },
  };
  // Migrate snapshots once. After v2, equality with a later user setting does
  // not mean an explicit project override has become inherited.
  if ((Number(next.version) || 0) < 2) {
    next.projects = cleanInheritedSubagentOverrides(next.projects, next.user);
  }
  if (scope === 'project') next.projects[workspace] = value;
  else next.user = value;
  next.version = 2;
  db.setSetting(KEYS.subagents, next);
  return value;
}

function getHarnessStore() {
  return readSettingWithRecovery(
    KEYS.harness,
    defaultHarnessStore(),
    (value) => {
      const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
      return normalizeHarnessStore({
        ...source,
        workspaceProfiles: absoluteScopedEntries(source.workspaceProfiles),
      });
    },
  );
}

function harnessProfileIdForWorkspace(store, cwd) {
  const workspace = canonicalWorkspaceKey(cwd);
  if (
    workspace
    && store.workspaceProfiles[workspace]
    && Object.hasOwn(store.profiles, store.workspaceProfiles[workspace])
  ) {
    return store.workspaceProfiles[workspace];
  }
  return store.activeProfileId;
}

function getHarnessProfile(cwd = '') {
  const store = getHarnessStore();
  return clone(store.profiles[harnessProfileIdForWorkspace(store, cwd)]);
}

function getTemporaryHarnessProfile() {
  const store = getHarnessStore();
  return clone(store.profiles[store.temporaryProfileId] || store.profiles[DEFAULT_TEMPORARY_HARNESS_PROFILE.id]);
}

function getHarnessSettings(cwd = '') {
  const store = getHarnessStore();
  const workspace = canonicalWorkspaceKey(cwd);
  const activeProfileId = harnessProfileIdForWorkspace(store, cwd);
  return {
    version: store.version,
    activeProfileId,
    globalProfileId: store.activeProfileId,
    temporaryProfileId: store.temporaryProfileId,
    workspaceProfileId: workspace ? store.workspaceProfiles[workspace] || '' : '',
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
  const exists = Object.hasOwn(store.profiles, requestedId);
  if (payload.mode === 'create' && exists) throw new Error('这个配置 ID 已存在，请使用其他 ID。');
  if (payload.mode === 'edit' && !exists) throw new Error('这份 Harness 配置已被删除。');
  if (!exists && Object.keys(store.profiles).length >= MAX_HARNESS_PROFILES) {
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
    builtin: Object.hasOwn(BUILTIN_HARNESS_PROFILES, requestedId),
  }, current);
  db.setSetting(KEYS.harness, store);
  return getHarnessSettings(payload.cwd);
}

function selectHarnessProfile(payload = {}) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const id = typeof input.id === 'string' ? input.id : '';
  const store = getHarnessStore();
  if (
    input.scope !== undefined
    && !['global', 'workspace', 'inherit', 'temporary'].includes(input.scope)
  ) {
    throw new Error('Harness 应用范围无效');
  }
  const explicitWorkspace = input.scope === 'workspace' || input.scope === 'inherit';
  const requestedCwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  if (explicitWorkspace && (!requestedCwd || !path.isAbsolute(requestedCwd))) {
    throw new Error('Harness 工作区范围需要绝对工作区路径');
  }
  const workspace = requestedCwd && path.isAbsolute(requestedCwd)
    ? path.resolve(requestedCwd)
    : '';
  if (input.scope === 'inherit') {
    delete store.workspaceProfiles[workspace];
    getStudioDatabase().setSetting(KEYS.harness, store);
    return getHarnessSettings(workspace);
  }
  if (!HARNESS_PROFILE_ID.test(id) || !Object.hasOwn(store.profiles, id)) {
    throw new Error('Harness profile 不存在');
  }
  if (input.scope === 'temporary') {
    store.temporaryProfileId = id;
    getStudioDatabase().setSetting(KEYS.harness, store);
    return getHarnessSettings(workspace);
  }
  const cwd = input.scope === 'global' ? '' : workspace;
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
  const current = store.profiles[id];
  const baseline = BUILTIN_HARNESS_PROFILES[id] || DEFAULT_HARNESS_PROFILE;
  store.profiles[id] = {
    ...clone(baseline),
    id,
    name: current.builtin ? baseline.name : current.name,
    builtin: current.builtin,
    icon: current.icon,
  };
  getStudioDatabase().setSetting(KEYS.harness, store);
  return getHarnessSettings(input.cwd);
}

function deleteHarnessProfile(payload = {}) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const id = typeof input.id === 'string' ? input.id : '';
  if (Object.hasOwn(BUILTIN_HARNESS_PROFILES, id)) throw new Error('默认 Harness profile 不能删除');
  const store = getHarnessStore();
  if (!HARNESS_PROFILE_ID.test(id) || !Object.hasOwn(store.profiles, id)) {
    throw new Error('Harness profile 不存在');
  }
  delete store.profiles[id];
  for (const [cwd, profileId] of Object.entries(store.workspaceProfiles)) {
    if (profileId === id) delete store.workspaceProfiles[cwd];
  }
  if (store.activeProfileId === id) store.activeProfileId = DEFAULT_HARNESS_PROFILE.id;
  if (store.temporaryProfileId === id) store.temporaryProfileId = DEFAULT_TEMPORARY_HARNESS_PROFILE.id;
  getStudioDatabase().setSetting(KEYS.harness, store);
  return getHarnessSettings(input.cwd);
}

function getExtensionRegistryUrl() {
  return readSettingWithRecovery(
    KEYS.extensionRegistryUrl,
    '',
    (value) => {
      if (typeof value !== 'string' || !value.trim()) return '';
      try {
        return normalizeExtensionRegistryUrl(value);
      } catch {
        return '';
      }
    },
  );
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
  DEFAULT_PERMISSION_PROFILE_IDS,
  DEFAULT_TEMPORARY_HARNESS_PROFILE,
  HARNESS_SECTION_IDS,
  HARNESS_SECTIONS,
  KEYS,
  PALETTES,
  RADIUS_PRESETS,
  RADIUS_STYLES,
  PERMISSION_MODES,
  RUNTIME_POLICY_DEFAULTS,
  TEMPORARY_HARNESS_SECTIONS,
  THEMES,
  defaultHarnessStore,
  deletePermissionPoliciesForWorkspace,
  deletePermissionProfile,
  deleteWorkspaceScopedSettings,
  deleteHarnessProfile,
  getHarnessProfile,
  getHarnessSettings,
  getHarnessStore,
  getPermissionProfileById,
  getPermissionProfilesSnapshot,
  getPermissionProfilesStore,
  getTemporaryHarnessProfile,
  getTemporaryPermissionPolicy,
  getConversationExtensionUiPreferences,
  getExtensionRegistryUrl,
  getMenuBarEnabled,
  getPalette,
  getWindowBounds,
  getRadiusPreset,
  getRadiusStyle,
  getPermissionMode,
  getPermissionPolicyStore,
  getRuntimePolicy,
  getSubagentConfig,
  getTheme,
  normalizeHarnessProfile,
  normalizeHarnessSections,
  normalizeHarnessStore,
  normalizeRuntimePolicy,
  normalizeRadiusStyle,
  normalizeSectionOverrides,
  normalizeToolGuidance,
  resetHarnessProfile,
  resetPermissionProfile,
  saveHarnessProfile,
  savePermissionPolicyStore,
  savePermissionProfile,
  saveRuntimePolicy,
  saveConversationExtensionUiPreferences,
  selectHarnessProfile,
  selectPermissionProfile,
  setPermissionMode,
  setPermissionPolicy,
  setWindowBounds,
  setExtensionRegistryUrl,
  resetPermissionPolicy,
  setSubagentConfig,
};
