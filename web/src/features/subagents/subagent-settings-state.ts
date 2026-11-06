/** Result ownership, not cancellation of main-process side effects. */
export function createSubagentSettingsOwner(scope: string) {
  let currentScope = scope;
  let generation = 0;
  let active = true;
  return {
    setScope(next: string) { if (next !== currentScope) { currentScope = next; generation++; } },
    activate() { active = true; },
    begin() { return { scope: currentScope, generation: ++generation }; },
    current(ticket: { scope: string; generation: number }) {
      return active && ticket.scope === currentScope && ticket.generation === generation;
    },
    dispose() { active = false; generation++; },
  };
}

/** User defaults affect every project's inherited snapshot. Keep reads behind writes even after unmount. */
export function createSubagentSettingsWrites() {
  let pending: Promise<void> | null = null;
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const task = (pending || Promise.resolve()).then(operation);
      const settled = task.then(() => undefined, () => undefined);
      pending = settled;
      void settled.then(() => { if (pending === settled) pending = null; });
      return task;
    },
    async wait() { while (pending) await pending; },
  };
}

/** Empty means inherit, never an empty permission set. Use the explicit restore action for that. */
export function toggleSubagentAllowedTool(current: string[], parent: string[], name: string): string[] | null {
  const base = current.length ? current : parent;
  const next = base.includes(name) ? base.filter((tool) => tool !== name) : [...base, name];
  return next.length ? [...new Set(next)] : null;
}
