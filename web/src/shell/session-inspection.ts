import type { InspectorTab } from './app-types';
import type { TodoDetails } from '../types/chat-types';
import type { ConversationEvent, LongTaskState } from '../types/durable-types';
import type { SubagentChild } from '../types/subagent-types';

export type CardPosition = { right: number; top: number };
export type CardSize = { width: number; height: number };
export type CardBounds = CardPosition & CardSize;
export const inspectionResizeEdges = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type InspectionHandle = 'move' | typeof inspectionResizeEdges[number];
export const minimumInspectionSize: CardSize = { width: 320, height: 200 };
export type Inspection = {
  mode: 'hidden' | 'compact' | 'expanded';
  tab: InspectorTab;
  progressPage?: 'summary' | 'tasks' | 'history';
  childKey?: string;
  position?: CardPosition;
  size?: CardSize;
  maximized?: boolean;
  seenTurn?: string;
};

export function emptyInspection(): Inspection {
  return { mode: 'hidden', tab: 'progress' };
}

export function restoreInspection(raw: unknown): Inspection {
  const view = emptyInspection();
  if (!raw || typeof raw !== 'object') return view;
  const saved = raw as Partial<Inspection>;
  if (saved.mode === 'compact' || saved.mode === 'expanded') view.mode = saved.mode;
  if (saved.tab === 'trace' || saved.tab === 'subagents') view.tab = saved.tab;
  if (saved.progressPage === 'tasks' || saved.progressPage === 'history') view.progressPage = saved.progressPage;
  if (typeof saved.childKey === 'string') view.childKey = saved.childKey;
  if (typeof saved.seenTurn === 'string') view.seenTurn = saved.seenTurn;
  if (saved.position && Number.isFinite(saved.position.right) && Number.isFinite(saved.position.top)) {
    view.position = saved.position;
  }
  if (saved.size && Number.isFinite(saved.size.width) && saved.size.width > 0
      && Number.isFinite(saved.size.height) && saved.size.height > 0) {
    view.size = { width: saved.size.width, height: saved.size.height };
  }
  if (saved.maximized === true) view.maximized = true;
  return view;
}

// Sizes are in CSS pixels. A dragged edge stops at the transcript boundary
// or the minimum panel size, keeping its opposite edge under the same point.
export function dragInspectionBounds(start: CardBounds, area: CardSize, handle: InspectionHandle, dx: number, dy: number): CardBounds {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  let width = Math.min(start.width, area.width);
  let height = Math.min(start.height, area.height);
  let right = clamp(start.right, 0, area.width - width);
  let top = clamp(start.top, 0, area.height - height);
  if (handle === 'move') {
    return { width, height, right: clamp(right - dx, 0, area.width - width), top: clamp(top + dy, 0, area.height - height) };
  }
  if (dx && handle.includes('w')) width = clamp(width - dx, minimumInspectionSize.width, area.width - right);
  if (dx && handle.includes('e')) {
    const available = right + width;
    width = clamp(width + dx, minimumInspectionSize.width, available);
    right = available - width;
  }
  if (dy && handle.includes('s')) height = clamp(height + dy, minimumInspectionSize.height, area.height - top);
  if (dy && handle.includes('n')) {
    const bottom = top + height;
    height = clamp(height - dy, minimumInspectionSize.height, bottom);
    top = bottom - height;
  }
  return { width, height, right, top };
}

// Hydration can rediscover work after a reload. Only a live activity from a new turn
// can reopen a card that the user explicitly dismissed.
export function noticeInspection(view: Inspection, turn: string, hydration = false): Inspection {
  if (view.seenTurn === turn || (hydration && view.seenTurn)) return view;
  return { ...view, seenTurn: turn, mode: view.mode === 'expanded' ? 'expanded' : 'compact' };
}

export function inspectionSummary(plan: TodoDetails | undefined, children: SubagentChild[], goal?: LongTaskState) {
  const tasks = plan?.tasks.filter(task => task.status !== 'deleted' && !task.archivedAt && !task.closedAt) ?? [];
  const active = tasks.find(task => task.status === 'in_progress');
  const agents = children.filter(child => child.status === 'pending' || child.status === 'running' || child.status === 'waiting');
  const activeGoal = goal?.enabled && goal.status === 'active' ? goal : undefined;
  const title = active?.activeForm || active?.subject || tasks.find(task => task.status === 'pending')?.subject
    || agents[0]?.task || activeGoal?.goal || '会话进展';
  const counts = [];
  if (tasks.length) counts.push(tasks.filter(task => task.status === 'completed').length + '/' + tasks.length + ' 项完成');
  if (agents.length) counts.push(agents.length + ' 个子智能体');
  return { title, detail: counts.join(' · '), activity: tasks.length && plan?.scope === 'turn' ? plan.turnId
    : agents[0]?.runId || activeGoal?.goalId || undefined };
}

/** Live conversation events also include runs that continue after switching away. */
export function inspectionActivityListener(notice: (id: string, turn: string) => void) {
  const turns = new Map<string, string>();
  const pending = new Map<string, Map<string, 'todo' | 'subagent'>>();
  return (event: ConversationEvent) => {
    const id = event.conversationId;
    switch (event.type) {
      case 'snapshot':
        if (event.payload.run?.inputs[0]) turns.set(id, String(event.payload.run.inputs[0]));
        break;
      case 'run.started':
        if (event.payload.inputs[0]) turns.set(id, String(event.payload.inputs[0]));
        break;
      case 'todo.changed':
        if (event.payload.turnId) turns.set(id, event.payload.turnId);
        break;
      case 'assistant.completed': {
        for (const block of event.payload.message.content) {
          if (block.type !== 'toolCall') continue;
          const action = block.arguments?.action;
          if ((block.name === 'todo' && (action === 'create' || action === 'createMany'))
              || (block.name === 'subagent' && (action === undefined || action === 'run' || action === 'spawn'))) {
            const calls = pending.get(id) ?? new Map<string, 'todo' | 'subagent'>();
            calls.set(block.id, block.name);
            pending.set(id, calls);
          }
        }
        break;
      }
      case 'transcript.appended':
        for (const message of event.payload.messages) {
          if (message.role !== 'toolResult' || !message.toolCallId) continue;
          const calls = pending.get(id);
          const kind = calls?.get(message.toolCallId);
          if (!kind || !calls?.delete(message.toolCallId) || message.isError) continue;
          const plan = kind === 'todo' ? message.details as Partial<TodoDetails> | undefined : undefined;
          notice(id, plan?.lastTurnId || plan?.turnId || turns.get(id) || message.toolCallId);
        }
        break;
      case 'tool.execution.started':
      case 'tool.execution.updated': {
        const call = String(event.payload.callId);
        const calls = pending.get(id);
        if (calls?.get(call) === 'subagent' && event.payload.status === 'running' && !event.payload.unoffered) {
          calls.delete(call);
          notice(id, turns.get(id) || call);
        }
        break;
      }
      case 'run.completed':
      case 'run.failed':
        if (event.payload.running) break;
        // Fall through to release per-run correlation data.
      case 'stream.closed':
        turns.delete(id);
        pending.delete(id);
        break;
    }
  };
}
