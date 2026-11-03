'use strict';

/**
 * Durable `ConversationView` → Studio IPC 事件的投影层。
 *
 * 这是 Studio 与 Pi Durable 实时契约之间唯一的耦合点。Durable 1.5.0 删除了
 * `watchEvents()`，把流式状态改成一份结构化的会话视图：
 *
 *   ConversationView = { conversation, entries, before?, docs }
 *   docs['pi.live']   运行控制 + 当前生成/工具轮的展示
 *   docs['pi.inbox']  排队中的输入
 *   docs['pi.agent']  模型与思考级别
 *   docs['pi.usage']  用量
 *
 * 本模块只有纯函数：不 import 任何 `@earendil-works/*`，不读时钟，不写存储。
 * 上游再改视图契约时，只需要改这一个文件。
 */

/** `pi.live` 文档的 kind；升级时若上游改名，这里会先炸。 */
const LIVE_DOC = 'pi.live';
const INBOX_DOC = 'pi.inbox';
const AGENT_DOC = 'pi.agent';
const USAGE_DOC = 'pi.usage';

function docOf(view, kind) {
  const docs = view && view.docs;
  if (!docs || typeof docs !== 'object') return undefined;
  const value = docs[kind];
  return value && typeof value === 'object' ? value : undefined;
}

/**
 * 把会话视图压成扁平快照。
 *
 * 形状与 1.4.0 `watchEvents().snapshot` 保持一致，这样 `liveSnapshotDto`、
 * `conversationSnapshot` 和渲染层的 `ConversationSnapshot` 都不需要改。
 */
function liveFromView(view) {
  const live = docOf(view, LIVE_DOC) || {};
  const inbox = docOf(view, INBOX_DOC);
  const agent = docOf(view, AGENT_DOC);
  const usage = docOf(view, USAGE_DOC);
  return {
    run: live.run,
    generation: live.generation,
    tools: Array.isArray(live.tools) ? live.tools : [],
    nestedTools: Array.isArray(live.nestedTools) ? live.nestedTools : [],
    compactions: Array.isArray(live.compactions) ? live.compactions : [],
    compactionFailure: live.compactionFailure,
    runFailure: live.runFailure,
    inbox: Array.isArray(inbox?.items) ? inbox.items : [],
    agent: agent || {},
    usage,
  };
}

/** 判断两次视图之间某个文档的值是否变了。 */
function documentsDiffer(previous, next) {
  return previous !== next;
}

function sameJson(left, right) {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/** 一次工具轮里，一个 slot 是否发生了需要通知渲染层的变化。 */
function toolSlotChanged(previous, next) {
  if (!previous) return true;
  return previous.status !== next.status
    || previous.output !== next.output
    || previous.droppedBytes !== next.droppedBytes
    || previous.droppedLines !== next.droppedLines
    || previous.entry !== next.entry
    || previous.taskId !== next.taskId
    || previous.unoffered !== next.unoffered
    || previous.details !== next.details
    || (previous.diagnostics?.length || 0) !== (next.diagnostics?.length || 0);
}

/**
 * 比较两份扁平快照，产出 Studio 的 IPC 事件。
 *
 * 返回的每一项是 `{ type, payload }`，`type` 与 `web/src/types/durable-types.ts`
 * 的 `ConversationEvent` 对齐。调用方负责补充只有它才知道的字段（`running`、
 * `revision`、`conversationId`）并执行副作用（启动/结束 turn diff 等）。
 */
function diffLive(previous, next) {
  const changes = [];
  if (!previous) return changes;

  const previousRun = previous.run;
  const nextRun = next.run;

  if (!previousRun && nextRun) {
    changes.push({ type: 'run.started', payload: { inputs: nextRun.inputs || [] } });
  }

  if (previousRun && !nextRun) {
    changes.push({ type: 'run.completed', payload: { inputs: previousRun.inputs || [] } });
  }

  // 流式回答：`pi.live.generation.message` 是不可变文档里的不可变值，
  // 引用不同即代表这一轮提交更新了它。
  const previousMessage = previous.generation?.message;
  const nextMessage = next.generation?.message;
  if (nextMessage && nextMessage !== previousMessage) {
    changes.push({ type: 'assistant.updated', payload: { message: nextMessage } });
  }

  const previousRetry = previous.generation?.retry;
  const nextRetry = next.generation?.retry;
  if (!previousRetry && nextRetry) {
    changes.push({
      type: 'retry.updated',
      payload: {
        active: true,
        attempt: next.generation?.attempt ?? 1,
        at: nextRetry.at,
        errorMessage: nextRetry.error,
      },
    });
  } else if (previousRetry && !nextRetry) {
    changes.push({
      type: 'retry.updated',
      payload: { active: false, attempt: next.generation?.attempt ?? 1 },
    });
  }

  const previousTools = new Map((previous.tools || []).map((slot) => [slot.callId, slot]));
  for (const slot of next.tools || []) {
    const before = previousTools.get(slot.callId);
    previousTools.delete(slot.callId);
    if (!before) {
      changes.push({ type: 'tool.execution.started', payload: { ...slot } });
      continue;
    }
    if (!toolSlotChanged(before, slot)) continue;
    changes.push({
      type: slot.status === 'done' ? 'tool.execution.completed' : 'tool.execution.updated',
      payload: { ...slot },
    });
  }

  const previousCompactions = new Map(
    (previous.compactions || []).map((status) => [String(status.taskId), status]),
  );
  for (const status of next.compactions || []) {
    const before = previousCompactions.get(String(status.taskId));
    if (before) continue;
    changes.push({
      type: 'compaction.started',
      payload: {
        taskId: status.taskId,
        // 1.5.0 把 `reason` 改名为 `trigger`；IPC 契约仍用 `reason`。
        reason: status.trigger,
        blocking: status.blocking,
        attempt: status.attempt,
        retry: status.retry,
      },
    });
  }
  for (const [taskId, status] of previousCompactions) {
    if ((next.compactions || []).some((item) => String(item.taskId) === taskId)) continue;
    const failure = next.compactionFailure
      && String(next.compactionFailure.taskId) === taskId
      ? next.compactionFailure
      : undefined;
    changes.push({
      type: 'compaction.completed',
      payload: {
        taskId: status.taskId,
        reason: status.trigger,
        error: failure?.error,
      },
    });
  }

  if (documentsDiffer(previous.inbox, next.inbox) && !sameJson(previous.inbox, next.inbox)) {
    changes.push({ type: 'inbox.updated', payload: { items: next.inbox } });
  }
  if (!sameJson(previous.agent, next.agent)) {
    changes.push({ type: 'agent.updated', payload: { agent: next.agent } });
  }
  if (!sameJson(previous.usage, next.usage)) {
    changes.push({ type: 'usage.updated', payload: { usage: next.usage } });
  }

  // 运行级失败：1.5.0 用 `pi.live.runFailure` 取代了 1.4 的 `task_failed`
  // 事件。`reason` 是新契约的核心信息，保留给渲染层做文案。
  if (next.runFailure && !sameJson(previous.runFailure, next.runFailure)) {
    const failure = next.runFailure;
    changes.push({
      type: 'run.failed',
      payload: {
        taskId: String(failure.taskId ?? ''),
        kind: 'generation',
        message: typeof failure.detail === 'string' && failure.detail
          ? failure.detail
          : String(failure.reason || ''),
        reason: failure.reason,
        detail: failure.detail,
      },
    });
  }

  return changes;
}

/**
 * 从窗口里取出此前没有通知过的 entry。
 *
 * `ConversationView.entries` 是一个窗口（默认最近 50 条，超过 100 条裁回 50），
 * 并且在 Chord 折叠超过 10,000 条待处理操作时会以 `[["r", view]]` 整体替换。
 * 因此这里按 ID 记忆已经发过的 entry：窗口裁剪不会重复发，根替换也不会把
 * 整段历史重发一遍。
 */
function newEntries(knownIds, entries) {
  const fresh = [];
  for (const entry of entries || []) {
    const id = entry?.id;
    if (id === undefined || knownIds.has(id)) continue;
    knownIds.add(id);
    fresh.push(entry);
  }
  return fresh;
}

/** 为新 watch 建立 ID 记忆集合（首帧的 entry 不算"新增"）。 */
function seedEntryIds(entries) {
  const ids = new Set();
  for (const entry of entries || []) {
    if (entry?.id !== undefined) ids.add(entry.id);
  }
  return ids;
}

module.exports = {
  LIVE_DOC,
  INBOX_DOC,
  AGENT_DOC,
  USAGE_DOC,
  appendedEntries: newEntries,
  diffLive,
  liveFromView,
  seedEntryIds,
};
