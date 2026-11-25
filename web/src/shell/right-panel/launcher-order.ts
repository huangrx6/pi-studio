export const launcherToolOrder = [
  'files', 'git', 'terminal', 'progress', 'subagents', 'trace', 'browser', 'services', 'temporary',
] as const;

export type RightPanelToolId = typeof launcherToolOrder[number];

export function orderLauncherEntries<T extends { id: string }>(entries: readonly T[], order: readonly string[]): T[] {
  const remaining = new Map(entries.map(entry => [entry.id, entry]));
  const ordered: T[] = [];
  for (const id of order) {
    const entry = remaining.get(id);
    if (!entry) continue;
    ordered.push(entry);
    remaining.delete(id);
  }
  return [...ordered, ...remaining.values()];
}

export function moveLauncherEntry(order: readonly string[], visibleIds: string[], source: string, target: string): string[] {
  const from = visibleIds.indexOf(source);
  const to = visibleIds.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...order];

  const visible = new Set(visibleIds);
  const nextIds = [...visibleIds];
  nextIds.splice(from, 1);
  nextIds.splice(to, 0, source);
  // Conversation-only tools and extensions from other workspaces keep their slots.
  const allIds = new Set([...order, ...launcherToolOrder, ...visibleIds]);
  let index = 0;
  return [...allIds].map(id => visible.has(id) ? nextIds[index++] : id);
}
