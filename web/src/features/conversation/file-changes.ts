import type { ChatMessage, TurnDiff } from '../../types/chat-types';

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

/**
 * 找回一轮对话的 turn diff。
 *
 * 写入侧把 diff.at 设为本轮最后一条助手消息的时间戳，正常情况是精确匹配；
 * 旧版本保存的是「结束时刻」，比消息时间戳晚几十秒，所以再退化到时间窗口：
 * 只要有 diff 落在 [本轮最后一条消息, 下一条用户消息) 之间，就属于这一轮。
 * 用「下一条用户消息」做上界，避免把下一轮的 diff 挂到没有改动的这一轮上。
 */
export function findTurnDiff(
  diffs: TurnDiff[] | undefined,
  { from, until }: { from?: number; until?: number },
): TurnDiff | undefined {
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined;
  if (typeof from !== 'number' || !Number.isFinite(from)) return undefined;
  const start = from;
  const exact = diffs.find((diff) => diff.at === start);
  if (exact) return exact;
  const upper = typeof until === 'number' && Number.isFinite(until) ? until : Number.POSITIVE_INFINITY;
  return diffs
    .filter((diff) => diff.at > start && diff.at < upper)
    .sort((left, right) => left.at - right.at)[0];
}
