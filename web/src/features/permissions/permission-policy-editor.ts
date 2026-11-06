import type { PermissionPolicy, PermissionRule, PermissionScope } from '../../types/permission-types';

/** Reject unfinished conditions instead of silently broadening them to the whole tool. */
export function permissionDraftError(policy: PermissionPolicy): string {
  for (const rule of policy.rules) {
    const name = rule.label.trim() || '自定义规则';
    if (!rule.match.tool.trim()) return `请填写“${name}”的工具名称。`;
    for (const condition of ['commandPrefix', 'commandExact', 'pathExact', 'pathGlob'] as const) {
      if (rule.match[condition] !== undefined && !rule.match[condition]?.trim()) {
        return `请填写“${name}”的${condition.startsWith('command') ? '命令' : '路径'}条件，或明确选择“工具本身”。`;
      }
    }
  }
  return '';
}

export function permissionScopeKey(scope: PermissionScope, cwd: string, sessionId: string): string {
  return JSON.stringify(scope === 'user' ? ['user'] : scope === 'workspace' ? [scope, cwd] : [scope, sessionId]);
}

/** An editor reopened during a write must read its outcome, not a pre-write snapshot. */
export function createPermissionWrites() {
  const pending = new Map<string, Promise<void>>();
  return {
    async run<T>(key: string, write: () => Promise<T>): Promise<T> {
      if (pending.has(key)) throw new Error('此作用域的权限策略正在保存，请稍后重试。');
      let release!: () => void;
      const settled = new Promise<void>((resolve) => { release = resolve; });
      pending.set(key, settled);
      try { return await write(); }
      finally {
        if (pending.get(key) === settled) pending.delete(key);
        release();
      }
    },
    async waitForContext(cwd: string, sessionId: string): Promise<void> {
      const keys = [permissionScopeKey('user', cwd, sessionId)];
      if (cwd) keys.push(permissionScopeKey('workspace', cwd, sessionId));
      if (sessionId) keys.push(permissionScopeKey('session', cwd, sessionId));
      while (keys.some((key) => pending.has(key))) {
        await Promise.all(keys.map((key) => pending.get(key)));
      }
    },
  };
}

export const permissionWrites = createPermissionWrites();

export type RuleCondition = 'tool' | 'commandPrefix' | 'commandExact' | 'pathExact' | 'pathGlob' | 'pathWithin';

export function ruleCondition(rule: PermissionRule): RuleCondition {
  if (rule.match.commandPrefix !== undefined) return 'commandPrefix';
  if (rule.match.commandExact !== undefined) return 'commandExact';
  if (rule.match.pathExact !== undefined) return 'pathExact';
  if (rule.match.pathGlob !== undefined) return 'pathGlob';
  if (rule.match.pathWithin) return 'pathWithin';
  return 'tool';
}


export function matchForCondition(tool: string, condition: RuleCondition, value: string): PermissionRule['match'] {
  const match: PermissionRule['match'] = { tool };
  if (condition === 'commandPrefix') match.commandPrefix = value;
  else if (condition === 'commandExact') match.commandExact = value;
  else if (condition === 'pathExact') match.pathExact = value;
  else if (condition === 'pathGlob') match.pathGlob = value;
  else if (condition === 'pathWithin') match.pathWithin = 'workspace';
  return match;
}
