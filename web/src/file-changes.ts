import type { ChatMessage } from './chat-types';

export type FileChange = {
  path: string;
  label: string;
  operations: Array<{ id: string; diff?: string; content?: string }>;
  added: number;
  removed: number;
  completeCounts: boolean;
};

function normalizedPath(path: string) {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else parts.push(part);
  }
  return `${path.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}

/** Only successful mutation tools are evidence of a change. Reads and shell
 * commands cannot establish a file delta from their arguments alone. */
export function collectFileChanges(messages: ChatMessage[], results: Map<string, ChatMessage>, cwd = ''): FileChange[] {
  const files = new Map<string, FileChange>();
  const seen = new Set<string>();
  for (const message of messages) for (const call of message.content) {
    if (call.type !== 'toolCall' || !['edit', 'write'].includes(call.name) || seen.has(call.id)) continue;
    seen.add(call.id);
    const result = results.get(call.id);
    if (!result || result.isError) continue;
    const target = call.arguments.path || call.arguments.file_path;
    if (typeof target !== 'string' || !target.trim()) continue;
    const path = normalizedPath(target.startsWith('/') || !cwd ? target : `${cwd}/${target}`);
    const root = normalizedPath(cwd).replace(/\/$/, '');
    const label = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
    const details = result.details && typeof result.details === 'object' ? result.details as Record<string, unknown> : {};
    const patch = typeof details.patch === 'string' ? details.patch : undefined;
    const diff = patch || (typeof details.diff === 'string' ? details.diff : undefined);
    const file = files.get(path) || { path, label, operations: [], added: 0, removed: 0, completeCounts: true };
    if (diff) {
      let hunk = !patch;
      for (const line of diff.split('\n')) {
        if (patch && line.startsWith('@@ ')) { hunk = true; continue; }
        if (!hunk) continue;
        if (line.startsWith('+')) file.added++;
        if (line.startsWith('-')) file.removed++;
      }
    } else file.completeCounts = false;
    file.operations.push({ id: call.id, diff, content: call.name === 'write' && typeof call.arguments.content === 'string' ? call.arguments.content : undefined });
    files.set(path, file);
  }
  return [...files.values()];
}
