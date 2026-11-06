/**
 * Agent tool-approval policy.
 *
 * The policy belongs to Studio and lives in SQLite. Durable's permission hook
 * reads it before every tool call, so policy changes and remembered approvals
 * apply to the next call without restarting a conversation.
 */

const { getStudioDatabase } = require('../../core/studio-db.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  PERMISSION_DECISIONS,
  PERMISSION_MODES,
  PRESET_DEFAULTS,
  approvalScopesFor,
  evaluatePermission,
  matchingPath,
  narrowApprovalRule,
  normalizePolicy,
} = require('../../core/permission-policy.cjs');
const {
  canonicalPermissionSessionId,
  getPermissionPolicyStore,
  resetPermissionPolicy: resetStoredPermissionPolicy,
  savePermissionPolicyStore,
  setPermissionMode,
  setPermissionPolicy: setStoredPermissionPolicy,
} = require('../../core/app-settings.cjs');

const MODES = Object.freeze([...PERMISSION_MODES]);
const DEFAULT_MODE = 'smart';
const POLICY_SCOPES = new Set(['user', 'workspace', 'session']);
const APPROVAL_SCOPES = new Set(['session', 'workspace', 'always']);
const MAX_SESSION_POLICY_ID = 256;
const RESERVED_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MODE_CATALOG = Object.freeze([
  {
    id: 'ask',
    label: '请求批准',
    description: '所有工具调用逐次确认；可保存精确到文件、命令或会话的规则。',
    defaultDecision: 'ask',
  },
  {
    id: 'smart',
    label: '帮我批准',
    description: '只自动允许明确的只读工具；风险或未知工具仍会确认。',
    defaultDecision: 'ask',
  },
  {
    id: 'full',
    label: '完全权限',
    description: '普通工具、跨工作区操作和无法静态确认的脚本直接执行；显式“询问/拒绝”与明显删除、系统破坏命令仍会拦截。',
    defaultDecision: 'allow',
  },
]);

function contextInput(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeWorkspacePath(value) {
  const cwd = typeof value === 'string' ? value.trim() : '';
  return cwd && path.isAbsolute(cwd) ? path.resolve(cwd) : cwd;
}

function cleanScope(value, { required = false } = {}) {
  if (value === undefined) {
    if (required) throw new Error('权限策略需要明确的作用域');
    return 'user';
  }
  if (!POLICY_SCOPES.has(value)) throw new Error('无效的权限作用域');
  return value;
}

function cleanSessionId(value) {
  const sessionId = canonicalPermissionSessionId(value);
  if (
    sessionId
    && (sessionId.length > MAX_SESSION_POLICY_ID || RESERVED_RECORD_KEYS.has(sessionId))
  ) {
    throw new Error('会话权限范围需要有效会话 ID');
  }
  return sessionId;
}

function requireScopeTarget(context, label = '权限策略') {
  if (context.scope === 'workspace') {
    if (!context.cwd || !path.isAbsolute(context.cwd)) {
      throw new Error(`${label}的工作区范围需要绝对工作区路径`);
    }
  } else if (context.scope === 'session' && !context.sessionId) {
    throw new Error(`${label}的会话范围需要有效会话 ID`);
  }
}

function cleanContext(input = {}, options = {}) {
  const source = contextInput(input);
  return {
    cwd: normalizeWorkspacePath(source.cwd),
    // The renderer uses public UUIDs while Durable hooks receive numeric IDs.
    // Permission policies always use the public UUID as the stable session key.
    sessionId: cleanSessionId(source.sessionId),
    scope: cleanScope(source.scope, { required: options.requireScope === true }),
    homeDir: typeof source.homeDir === 'string' ? source.homeDir : '',
  };
}

function conversationWorkspace(sessionId) {
  if (!sessionId) return '';
  return getStudioDatabase().getConversation(sessionId)?.workspace || '';
}

function resolveContext(input = {}, options = {}) {
  const context = cleanContext(input, options);
  if (!context.cwd && context.sessionId) {
    context.cwd = normalizeWorkspacePath(conversationWorkspace(context.sessionId));
  }
  return context;
}

function policyLayers(input = {}, options = {}) {
  const context = resolveContext(input);
  const store = getPermissionPolicyStore();
  const layers = [{ scope: 'user', policy: store.user }];
  if (context.cwd && store.workspaces[context.cwd]) {
    layers.push({ scope: 'workspace', policy: store.workspaces[context.cwd] });
  }
  if (context.sessionId && store.sessions[context.sessionId]) {
    layers.push({ scope: 'session', policy: store.sessions[context.sessionId] });
  }
  if (options.draft) {
    const draft = options.draft;
    const existing = layers.findIndex((layer) => layer.scope === draft.scope);
    if (existing >= 0) layers[existing] = draft;
    else layers.push(draft);
    const rank = { user: 0, workspace: 1, session: 2 };
    layers.sort((left, right) => rank[left.scope] - rank[right.scope]);
  }
  return { context, store, layers };
}

function policyState(input = {}) {
  const { context, store, layers } = policyLayers(input);
  const effective = layers[layers.length - 1];
  return {
    available: modeAvailable(),
    mode: effective.policy.preset,
    effectivePolicy: effective.policy,
    effectiveScope: effective.scope,
    layers,
    cwd: context.cwd,
    sessionId: context.sessionId,
    scopes: {
      user: store.user,
      workspace: context.cwd ? store.workspaces[context.cwd] || null : null,
      session: context.sessionId ? store.sessions[context.sessionId] || null : null,
    },
    catalog: {
      modes: MODE_CATALOG,
      decisions: [
        { id: 'allow', label: '允许' },
        { id: 'ask', label: '询问' },
        { id: 'deny', label: '拒绝' },
      ],
      decisionsAreValid: PERMISSION_DECISIONS,
      presetDefaults: PRESET_DEFAULTS,
    },
    path: 'SQLite · studio.permissions.policy',
  };
}

function readMode(input = {}) {
  return policyState(input).mode;
}

function writePolicy(payload = {}) {
  const input = contextInput(payload);
  const context = cleanContext(input, { requireScope: true });
  requireScopeTarget(context);
  setStoredPermissionPolicy({
    scope: context.scope,
    cwd: context.cwd,
    sessionId: context.sessionId,
    policy: normalizePolicy(input.policy, { strict: true }),
  });
  return policyState(context);
}

function writeMode(mode, options = {}) {
  if (!MODES.includes(mode)) throw new Error('无效的权限模式');
  const input = contextInput(options);
  const context = cleanContext(input);
  requireScopeTarget(context);
  setPermissionMode(mode, context);
  return policyState(context);
}

function resetPolicy(payload = {}) {
  const input = contextInput(payload);
  const context = cleanContext(input, { requireScope: true });
  requireScopeTarget(context);
  resetStoredPermissionPolicy({
    scope: context.scope,
    cwd: context.cwd,
    sessionId: context.sessionId,
  });
  return policyState(context);
}

async function realPathProtection(call, context) {
  const selected = matchingPath(call, context);
  if (!selected || !context.cwd) return undefined;
  const root = path.resolve(context.cwd);
  const lexical = selected.absolute;
  if (lexical !== root && !lexical.startsWith(`${root}${path.sep}`)) return undefined;
  try {
    const realRoot = await fs.realpath(root);
    let cursor = lexical;
    const missing = [];
    let realTarget;
    while (true) {
      try {
        const realAncestor = await fs.realpath(cursor);
        realTarget = path.join(realAncestor, ...missing);
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT') return undefined;
        const parent = path.dirname(cursor);
        if (parent === cursor) return undefined;
        missing.unshift(path.basename(cursor));
        cursor = parent;
      }
    }
    if (realTarget === realRoot || realTarget.startsWith(`${realRoot}${path.sep}`)) return undefined;
    return {
      title: '受保护的工作区边界',
      detail: '该路径通过符号链接指向当前工作区之外，已由 Studio 安全边界拦截。',
    };
  } catch {
    // Nonexistent or inaccessible roots still retain the lexical boundary check
    // performed by the pure policy engine.
    return undefined;
  }
}

async function evaluatePolicy(input, context, layers, extra = {}) {
  const result = evaluatePermission(layers, input.call, context);
  const fullAccess = normalizePolicy(layers[layers.length - 1]?.policy).preset === 'full';
  const resolvedBoundary = fullAccess && result.decision === 'allow'
    ? undefined
    : result.decision === 'deny'
    ? undefined
    : await realPathProtection(input.call, context);
  if (!resolvedBoundary) {
    return {
      ...result,
      rememberScopes: approvalScopesFor(input.call, context),
      cwd: context.cwd,
      sessionId: context.sessionId,
      ...extra,
    };
  }
  return {
    ...result,
    decision: 'deny',
    hardProtection: resolvedBoundary,
    explanation: resolvedBoundary.detail,
    rememberScopes: approvalScopesFor(input.call, context),
    cwd: context.cwd,
    sessionId: context.sessionId,
    ...extra,
  };
}

async function evaluateToolCall(input = {}) {
  const context = resolveContext(input);
  const { layers } = policyLayers(context);
  return evaluatePolicy(input, context, layers);
}

/**
 * Evaluate an unsaved policy draft with the same resolver and filesystem
 * boundary checks as the live hook. This function never persists the draft.
 */
async function previewToolCall(input = {}) {
  const context = resolveContext(input, { requireScope: true });
  requireScopeTarget(context, '预览策略');
  const scope = context.scope;
  const policy = normalizePolicy(input.policy, { strict: true });
  const { layers } = policyLayers(context, {
    draft: { scope, policy },
  });
  return evaluatePolicy(input, context, layers, { previewScope: scope });
}

function rememberApproval(payload = {}) {
  const input = contextInput(payload);
  if (input.remember !== undefined && !APPROVAL_SCOPES.has(input.remember)) {
    throw new Error('无效的批准范围');
  }
  if (input.scope !== undefined && !APPROVAL_SCOPES.has(input.scope)) {
    throw new Error('无效的批准范围');
  }
  const requested = input.remember || input.scope;
  if (!APPROVAL_SCOPES.has(requested)) {
    throw new Error('无效的批准范围');
  }
  const scope = requested === 'always' ? 'user' : requested;
  const context = resolveContext({ ...input, scope }, { requireScope: true });
  if (!approvalScopesFor(input.call, context).includes(requested)) {
    throw new Error('这个工具调用不支持所选批准范围');
  }
  requireScopeTarget(context, '批准规则');
  const store = getPermissionPolicyStore();
  const current = scope === 'workspace'
    ? store.workspaces[context.cwd] || store.user
    : scope === 'session'
      ? store.sessions[context.sessionId]
        || (context.cwd ? store.workspaces[context.cwd] : undefined)
        || store.user
      : store.user;
  const rule = narrowApprovalRule(
    input.call,
    context,
    input.label || `批准 ${input.call?.name || '工具'}`,
  );
  if (current.rules.some((candidate) => JSON.stringify(candidate.match) === JSON.stringify(rule.match))) {
    return policyState(context);
  }
  const next = {
    ...current,
    rules: [...current.rules, rule].slice(-128),
  };
  if (scope === 'workspace') store.workspaces[context.cwd] = normalizePolicy(next);
  else if (scope === 'session') store.sessions[context.sessionId] = normalizePolicy(next);
  else store.user = normalizePolicy(next);
  savePermissionPolicyStore(store);
  return policyState(context);
}

function modeAvailable() {
  return true;
}

module.exports = {
  DEFAULT_MODE,
  MODE_CATALOG,
  MODES,
  evaluateToolCall,
  modeAvailable,
  policyState,
  previewToolCall,
  readMode,
  rememberApproval,
  resetPolicy,
  resolveContext,
  writeMode,
  writePolicy,
};
