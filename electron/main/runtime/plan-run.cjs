const { getStudioDatabase } = require('../core/studio-db.cjs');
const { createConversation, submitConversation } = require('./conversations.cjs');
const { getDurableRuntime } = require('./durable-runtime.cjs');
const { releaseProviderSession } = require('./provider-session.cjs');
const { endBrowserSession } = require('../services/browser/queue.cjs');

/** One archived project chat per occurrence. A stable request ID also covers a crash after admission. */
async function executePlanRun(run, { signal, bindSession }) {
  const runtime = await getDurableRuntime();
  const { context, harness, storage } = runtime;
  const { withAbortSignal } = await import('@earendil-works/chord/context');
  const waiting = withAbortSignal(signal, context);
  const studio = getStudioDatabase();
  const sessionId = run.id;
  let row = studio.getConversation(sessionId);
  if (!row) {
    signal.throwIfAborted();
    if (run.session_id) throw new Error('本次运行的会话已被删除');
    await createConversation({ cwd: run.workspace, title: run.name }, { scheduledRunId: sessionId });
    row = studio.getConversation(sessionId);
  }
  if (!row) throw new Error('计划会话不存在');
  const conversation = await harness.conversation(Number(row.id), context);
  if (!conversation) throw new Error('计划会话不存在');
  try {
    bindSession(sessionId);
    // Recover using the Durable receipt before deciding whether to submit. This
    // also lets a completed run publish its actual outcome after an unclean exit.
    const previous = await storage.submissionByRequest(conversation.id, run.id, context);
    if (!previous || !['done', 'unanswered'].includes(previous.status)) signal.throwIfAborted();
    const id = previous?.id ?? Number((await submitConversation({
      id: sessionId, text: run.prompt, requestId: run.id, whenBusy: 'reject',
    }, { signal })).submissionId);
    let settled = previous;
    if (!settled || !['done', 'unanswered'].includes(settled.status)) {
      const submission = await harness.submission(id, context);
      if (!submission) throw new Error('找不到本次运行的执行记录');
      settled = await submission.wait(waiting);
    }
    if (settled.status !== 'done') {
      if (settled.reason === 'aborted') return { status: 'cancelled', detail: '执行已停止' };
      throw new Error(typeof settled.detail?.message === 'string' ? settled.detail.message : `执行未完成（${settled.reason}）`);
    }
    // Allow foreground completion hooks to settle before closing owned background work.
    if (!signal.aborted) await conversation.waitForIdle(waiting);
    const receipt = await storage.entry(conversation.id, settled.answer, context);
    const answer = receipt?.entry.model?.findLast(message => message.role === 'assistant');
    if (answer?.stopReason === 'error') throw new Error(answer.errorMessage || '模型请求失败');
    if (answer?.stopReason === 'aborted') return { status: 'cancelled', detail: '执行已停止' };
    const text = typeof answer?.content === 'string' ? answer.content
      : answer?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || '';
    return { status: 'succeeded', detail: text };
  } finally {
    // Wait for cancellation, including owned background tools, before freeing a slot.
    // Keep Durable's transcript on disk for the run history and later review.
    try { await conversation.abort(context, { background: true }); }
    finally {
      for (const id of studio.ownedConversationIds([conversation.id])) {
        endBrowserSession(id);
        await releaseProviderSession(runtime, id);
      }
    }
  }
}

module.exports = { executePlanRun };
