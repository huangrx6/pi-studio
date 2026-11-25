import type { ChatMessage } from '../../types/chat-types.ts';
import type { ConversationImage } from './ConversationImageGallery';
import { toolPreview, toolTitle } from './thinking-map-model.ts';
import { activityKind, type ActivityEntry, type BuiltTurnContent } from './turn-content.ts';

type ToolEntry = Extract<ActivityEntry, { kind: 'tool' }>;

function compactTarget(value: string) {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > 80 ? text.slice(0, 79) + '…' : text;
}

export function progressEntryLabel(entry: ActivityEntry): string {
  if (entry.kind === 'thinking') return '思考';
  const { call } = entry;
  const kind = activityKind(entry);
  const args = call.arguments || {};
  if (call.name === 'todo') return '整理任务清单';
  if (kind === 'agent') {
    const action = call.name === 'bg_wait' ? 'wait' : call.name === 'subagent_stop' ? 'stop' : args.action;
    const label = action === 'wait' ? '等待子任务' : action === 'stop' ? '停止子任务'
      : action === 'status' ? '查看子任务进展' : '处理子任务';
    return typeof args.name === 'string' && args.name.trim() ? `${label} · ${compactTarget(args.name)}` : label;
  }
  const name = toolTitle(call, kind);
  const verb = kind === 'command' ? '运行' : call.name === 'read' ? '读取'
    : kind === 'edit' ? '修改' : kind === 'write' ? '写入' : name;
  if (kind === 'other') return `调用 ${compactTarget(name)}`;
  // Typed browser input can contain form values. Only describe the operation in chat.
  if (call.name === 'browser_type') return '填写网页表单';
  const preview = toolPreview(call, kind);
  if (!preview || /^data:/i.test(preview)) return name;
  if (typeof args.url === 'string' && (kind === 'browser' || kind === 'fetch')) {
    try { return `${verb} · ${new URL(args.url).hostname || '网页'}`; } catch { return name; }
  }
  return `${verb} ${compactTarget(preview)}`;
}

export function buildTurnProgress(built: BuiltTurnContent, results: ReadonlyMap<string, ChatMessage>, live: boolean,
  retry?: { attempt: number; maxAttempts: number }) {
  const entries: ActivityEntry[] = [];
  const images = new Map<string, ConversationImage[]>();
  let failed = 0;
  let pending = 0;
  let firstPending: ToolEntry | undefined;
  for (const segment of built.segments) {
    if (segment.kind === 'tool-images') {
      const previous = images.get(segment.callId);
      images.set(segment.callId, previous ? previous.concat(segment.images) : segment.images);
    } else if (segment.kind === 'activity') {
      for (const entry of segment.entries) {
        entries.push(entry);
        if (entry.kind !== 'tool') continue;
        const result = results.get(entry.call.id);
        if (result?.isError) failed++;
        if (live && entry.live && !result) {
          firstPending ??= entry;
          pending++;
        }
      }
    }
  }
  let action = '';
  if (live) {
    const last = entries.at(-1);
    if (retry) action = `正在重试请求（${retry.attempt}/${retry.maxAttempts}）`;
    else if (firstPending) {
      action = `正在${progressEntryLabel(firstPending)}`;
      if (pending > 1) action += `（另有 ${pending - 1} 项进行中）`;
    } else if (built.lastBlock?.type === 'thinking') action = '正在思考';
    else if (built.lastBlock?.type === 'toolCall' && last?.kind === 'tool') {
      const result = results.get(last.call.id);
      if (result) {
        const label = progressEntryLabel(last);
        action = result.isError ? `${label}失败` : `已${label}`;
      }
    } else if (!built.lastBlock) action = '正在准备回复';
  }
  return { entries, images, action, failed };
}
