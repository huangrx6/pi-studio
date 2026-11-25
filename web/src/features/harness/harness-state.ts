import type { HarnessProfile, HarnessSettingsSnapshot, RuntimePolicy } from '../../types/harness-types';

export type CommitHarnessChange = (write: () => Promise<HarnessSettingsSnapshot>, success: string, finish?: () => Promise<void>) => Promise<void>;

export function cloneHarnessProfile(profile: HarnessProfile): HarnessProfile {
  return { ...profile, icon: profile.icon && { ...profile.icon }, sections: { ...profile.sections },
    sectionOverrides: { ...profile.sectionOverrides }, toolGuidance: { ...profile.toolGuidance } };
}
export function cloneRuntimePolicy(policy: RuntimePolicy): RuntimePolicy {
  return { ...policy, retry: { ...policy.retry }, compaction: { ...policy.compaction }, longTask: { ...policy.longTask } };
}
export type GuidanceRow = { key: number; name: string; guidance: string };
export function toolGuidanceNameError(name: string, used: ReadonlySet<string>): string | null {
  if (!name) return '请填写工具名称。';
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) {
    return '请输入有效的工具标识，可使用字母、数字、点、横线、下划线或冒号。';
  }
  return used.has(name) ? `工具“${name}”已有说明。` : null;
}

export function guidanceDraft(rows: GuidanceRow[]): { value: Record<string, string>; error: string | null } {
  const entries: Array<[string, string]> = [];
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    const error = toolGuidanceNameError(name, names);
    if (error) return { value: Object.fromEntries(entries), error };
    names.add(name); entries.push([name, row.guidance]);
  }
  return { value: Object.fromEntries(entries), error: null };
}

/** UI ownership only: invalidating a ticket does not cancel committed main-process work. */
export function createHarnessRequestOwner(cwd: string) {
  let scope = cwd; let generation = 0; let active = true;
  return {
    setScope(next: string) { if (next !== scope) { scope = next; generation++; } },
    activate() { active = true; },
    begin() { return { cwd: scope, generation: ++generation }; },
    current(ticket: { cwd: string; generation: number }) { return active && ticket.cwd === scope && ticket.generation === generation; },
    dispose() { active = false; generation++; },
  };
}

/** All Harness profiles and runtime policy share the global Studio store. */
export function createHarnessWriteQueue() {
  let pending: Promise<void> | null = null;
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const task = (pending || Promise.resolve()).then(operation);
      const settled = task.then(() => undefined, () => undefined);
      pending = settled;
      void settled.then(() => { if (pending === settled) pending = null; });
      return task;
    },
    async wait(): Promise<void> { while (pending) await pending; },
  };
}
