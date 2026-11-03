/**
 * Run the same prompt from one parent conversation in two isolated forks.
 *
 * Comparison branches are ordinary Studio conversations. This service only
 * coordinates their creation, submission and renderer-safe status projection;
 * Durable remains the source of execution, messages and run state.
 */

const { randomUUID } = require('node:crypto');

const MAX_PROMPT_CHARS = 200_000;
const MAX_ANSWER_CHARS = 200_000;
const MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*\/\S{1,240}$/;
const THINKING_LEVELS = new Set([
  'default',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function text(value, maximum = 1_000) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function modelRef(value) {
  const normalized = text(value, 320);
  return MODEL_REF.test(normalized) ? normalized : '';
}

function thinkingLevel(value) {
  return THINKING_LEVELS.has(value) ? value : 'default';
}

function normalizeBranches(value) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('模型对比需要两个分支');
  }
  const branches = value.map((branch, index) => {
    const ref = modelRef(branch?.modelRef);
    if (!ref) throw new Error(`分支 ${index + 1} 的模型标识无效`);
    return {
      label: text(branch?.label, 80) || `分支 ${index + 1}`,
      modelRef: ref,
      thinkingLevel: thinkingLevel(branch?.thinkingLevel),
    };
  });
  if (branches[0].modelRef === branches[1].modelRef) {
    throw new Error('请为两个分支选择不同的模型');
  }
  return branches;
}

function messageText(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .slice(0, MAX_ANSWER_CHARS);
}

function latestAnswer(page) {
  const candidates = [
    ...(Array.isArray(page?.messages) ? page.messages : []),
    ...(page?.generation ? [page.generation] : []),
  ];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    // A fork contains the parent's old answers. They are not answers to the
    // comparison prompt if this turn has not produced an assistant message.
    if (candidate?.role === 'user') break;
    const answer = messageText(candidate);
    if (!answer && !candidate?.errorMessage) continue;
    return {
      text: answer,
      streaming: candidate.streaming === true || page.running === true,
      error: text(candidate.errorMessage, 4_000),
      stopReason: text(candidate.stopReason, 200),
      model: text(candidate.model, 240),
      provider: text(candidate.provider, 160),
      thinkingLevel: text(candidate.thinkingLevel, 40),
    };
  }
  return undefined;
}

function branchStatus(page, branch) {
  const answer = latestAnswer(page);
  const status = page?.running
    ? 'running'
    : answer?.error
      ? 'failed'
      : answer
        ? 'completed'
        : 'unanswered';
  return {
    worktreeId: branch.worktreeId,
    sessionId: branch.sessionId,
    label: branch.label,
    modelRef: branch.modelRef,
    status,
    title: page?.title || branch.label,
    cwd: page?.cwd || '',
    running: Boolean(page?.running),
    compacting: Boolean(page?.compacting),
    answer,
  };
}

function createModelComparisonService(overrides = {}) {
  const dependencies = {
    conversationAction: (...args) => (
      require('../runtime/conversations.cjs').conversationAction(...args)
    ),
    conversationPage: (...args) => (
      require('../runtime/conversations.cjs').conversationPage(...args)
    ),
    configureConversation: (...args) => (
      require('../runtime/conversations.cjs').configureConversation(...args)
    ),
    submitConversation: (...args) => (
      require('../runtime/conversations.cjs').submitConversation(...args)
    ),
    configureConversationAgentCwd: (...args) => (
      require('../runtime/conversations.cjs').configureConversationAgentCwd(...args)
    ),
    abortConversation: (...args) => (
      require('../runtime/conversations.cjs').abortConversation(...args)
    ),
    bindManagedWorktree: (...args) => (
      require('../capabilities/subagents/index.cjs').bindManagedWorktree(...args)
    ),
    completeManagedWorktree: (...args) => (
      require('../capabilities/subagents/index.cjs').completeManagedWorktree(...args)
    ),
    createManagedWorktree: (...args) => (
      require('../capabilities/subagents/index.cjs').createManagedWorktree(...args)
    ),
    discardManagedWorktree: (...args) => (
      require('../capabilities/subagents/index.cjs').discardManagedWorktree(...args)
    ),
    inspectManagedWorktree: (...args) => (
      require('../capabilities/subagents/index.cjs').inspectManagedWorktree(...args)
    ),
    applyManagedWorktree: (...args) => (
      require('../capabilities/subagents/index.cjs').applyManagedWorktree(...args)
    ),
    metricTotals: (conversationId) => (
      require('../core/studio-db.cjs')
        .getStudioDatabase()
        .metricTotalsForConversation(conversationId)
    ),
    metricRequests: (options) => {
      const db = require('../core/studio-db.cjs').getStudioDatabase();
      const row = db.getConversation(options.conversationId);
      return row ? db.listMetricRequests({ ...options, conversationId: row.id }) : [];
    },
    ...overrides,
  };

  async function cleanupBranches(branches) {
    const results = await Promise.allSettled(branches.map(async (branch) => {
      // A failed stop must never be followed by deletion of a running branch.
      if (branch.sessionId) await dependencies.abortConversation(branch.sessionId);
      if (branch.sessionId) {
        await dependencies.conversationAction({ kind: 'session', id: branch.sessionId, action: 'remove' });
      }
      if (branch.worktreeId) {
        await dependencies.discardManagedWorktree(branch.worktreeId, { force: true, missingOk: true });
      }
    }));
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) {
      throw new AggregateError(errors, `对比分支清理失败：${errors.map((error) => error.message || String(error)).join('；')}`);
    }
  }

  async function start(input = {}) {
    const parentId = text(input.parentId, 200);
    if (!parentId) throw new Error('父会话标识无效');
    const prompt = text(input.prompt, MAX_PROMPT_CHARS);
    if (!prompt) throw new Error('请输入要对比的问题');
    const branches = normalizeBranches(input.branches);
    const mentions = Array.isArray(input.mentions)
      ? [...new Set(input.mentions
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim().slice(0, 4_096)))]
        .slice(0, 256)
      : [];
    const attachments = Array.isArray(input.attachments)
      ? input.attachments
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim().slice(0, 4_096))
        .slice(0, 64)
      : [];
    const images = Array.isArray(input.images)
      ? input.images
        .filter((item) => (
          item?.type === 'image'
          && typeof item.data === 'string'
          && typeof item.mimeType === 'string'
        ))
        .slice(0, 16)
      : [];

    const parent = await dependencies.conversationPage(parentId, { limit: 1 });
    if (!parent) throw new Error('父会话不存在');
    if (parent.running) throw new Error('请等待当前回答结束，或先停止任务');

    const comparisonId = randomUUID();
    const created = [];
    try {
      for (const [index, branch] of branches.entries()) {
        const worktreeId = `comparison:${comparisonId}:${index + 1}`;
        const createdBranch = {
          ...branch,
          sessionId: '',
          worktreeId: '',
        };
        created.push(createdBranch);
        const worktree = await dependencies.createManagedWorktree({
          id: worktreeId,
          parentConversationId: parentId,
          workspace: parent.cwd,
          name: `compare-${index + 1}`,
        });
        createdBranch.worktreeId = worktree.id;
        const fork = await dependencies.conversationAction({
          kind: 'session',
          id: parentId,
          action: 'fork',
        });
        if (!fork?.id) throw new Error('无法创建模型对比分支');
        const sessionId = String(fork.id);
        createdBranch.sessionId = sessionId;
        await dependencies.bindManagedWorktree(worktree.id, sessionId);
        await dependencies.conversationAction({
          kind: 'session',
          id: sessionId,
          action: 'long-task-clear',
        });
        await dependencies.configureConversation({
          id: sessionId,
          modelRef: branch.modelRef,
          thinkingLevel: branch.thinkingLevel,
        });
        await dependencies.configureConversationAgentCwd(sessionId, worktree.path);
        await dependencies.conversationAction({
          kind: 'session',
          id: sessionId,
          action: 'rename',
          name: `对比 · ${branch.label}`.slice(0, 80),
        });
      }

      const submissions = await Promise.allSettled(created.map((branch) => (
        dependencies.submitConversation({
          id: branch.sessionId,
          text: prompt,
          requestId: randomUUID(),
          whenBusy: 'reject',
          mentions,
          attachments,
          images,
        })
      )));
      const rejected = submissions.find((result) => result.status === 'rejected');
      if (rejected) throw rejected.reason;

      return {
        id: comparisonId,
        parentId,
        prompt,
        createdAt: Date.now(),
        branches: created.map(({
          sessionId,
          label,
          modelRef: ref,
          thinkingLevel: level,
          worktreeId,
        }) => ({
          sessionId,
          label,
          modelRef: ref,
          thinkingLevel: level,
          worktreeId,
        })),
      };
    } catch (error) {
      try {
        await cleanupBranches(created);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${error.message || String(error)}；${cleanupError.message}`);
      }
      throw error;
    }
  }

  async function snapshot(input = {}) {
    if (!Array.isArray(input.branches) || input.branches.length !== 2) {
      throw new Error('模型对比分支无效');
    }
    const branches = input.branches.map((branch, index) => ({
      sessionId: text(branch?.sessionId, 200) || `missing-${index + 1}`,
      label: text(branch?.label, 80) || `分支 ${index + 1}`,
      modelRef: modelRef(branch?.modelRef),
      worktreeId: text(branch?.worktreeId, 240),
    }));
    return Promise.all(branches.map(async (branch) => {
      let page;
      try {
        page = await dependencies.conversationPage(branch.sessionId, { limit: 160 });
      } catch (error) {
        return {
          ...branch,
          status: 'failed',
          title: branch.label,
          cwd: '',
          running: false,
          compacting: false,
          answer: {
            text: '',
            streaming: false,
            error: error instanceof Error ? error.message : String(error),
          },
          metrics: { requests: 0, tokens: 0, costUsd: 0 },
        };
      }
      if (!page) {
        return {
          ...branch,
          status: 'missing',
          title: branch.label,
          cwd: '',
          running: false,
          compacting: false,
          answer: undefined,
          metrics: { requests: 0, tokens: 0, costUsd: 0 },
        };
      }
      const totals = dependencies.metricTotals(branch.sessionId);
      const latest = dependencies.metricRequests({ conversationId: branch.sessionId, limit: 1 })[0];
      let worktree;
      if (branch.worktreeId) {
        try {
          const owned = await dependencies.inspectManagedWorktree(branch.worktreeId);
          if (String(owned.childConversationId) !== branch.sessionId) {
            throw new Error('工作树与模型对比分支不匹配');
          }
          let detail = owned;
          if (!page.running && owned.status === 'active') {
            const answer = latestAnswer(page);
            await dependencies.completeManagedWorktree(branch.worktreeId, {
              status: answer?.error ? 'failed' : 'finished',
              error: answer?.error || '',
            });
            detail = await dependencies.inspectManagedWorktree(branch.worktreeId);
          }
          worktree = {
            id: detail.id,
            status: detail.status,
            changedFiles: Number(detail.changedFiles) || 0,
            files: Array.isArray(detail.files) ? detail.files : [],
            sizeBytes: Number(detail.sizeBytes) || 0,
            error: text(detail.error || (
              ['applied', 'discarded', 'removed'].includes(detail.status) ? '' : detail.inspectionError
            ), 4_000),
            directoryExists: detail.directoryExists === true,
          };
        } catch (error) {
          worktree = {
            id: branch.worktreeId,
            status: 'failed',
            changedFiles: 0,
            files: [],
            sizeBytes: 0,
            error: error instanceof Error ? error.message : String(error),
            directoryExists: false,
          };
        }
      }
      return {
        ...branchStatus(page, branch),
        ...(worktree ? { worktree } : {}),
        metrics: {
          requests: Number(totals.requests) || 0,
          tokens: Number(totals.tokens) || 0,
          costUsd: Number(totals.cost) || 0,
          tps: Number(latest?.tps) || 0,
          ttftMs: Number(latest?.ttftMs) || 0,
          durationMs: Number(latest?.durationMs) || 0,
        },
      };
    }));
  }

  async function adopt(input = {}) {
    const sessionId = text(input.sessionId, 200);
    const worktreeId = text(input.worktreeId, 240);
    if (!sessionId) throw new Error('模型对比分支无效');
    const page = await dependencies.conversationPage(sessionId, { limit: 1 });
    if (!page) throw new Error('模型对比分支不存在');
    if (page.running) throw new Error('该分支仍在运行，结束后才能应用');
    if (!worktreeId) throw new Error('模型对比工作树标识无效');
    const detail = await dependencies.inspectManagedWorktree(worktreeId);
    if (String(detail.childConversationId) !== sessionId) {
      throw new Error('工作树与模型对比分支不匹配');
    }
    let status = detail.status;
    if (status === 'active') {
      const completed = await dependencies.completeManagedWorktree(worktreeId, {
        status: latestAnswer(page)?.error ? 'failed' : 'finished',
      });
      status = completed?.status || status;
    }
    if (status === 'failed') {
      throw new Error(detail.error || '该对比分支执行失败，不能应用工作树');
    }
    if (status === 'finished') {
      await dependencies.applyManagedWorktree(worktreeId);
    } else if (!['removed', 'applied'].includes(status)) {
      throw new Error('这个模型对比工作树已经处理，不能再应用');
    }
    await dependencies.configureConversationAgentCwd(sessionId, page.cwd);
    return {
      ok: true,
      changedFiles: Number(detail.changedFiles) || 0,
      sessionId,
    };
  }

  async function discard(input = {}) {
    const sessionId = text(input.sessionId, 200);
    const worktreeId = text(input.worktreeId, 240);
    if (!sessionId) throw new Error('模型对比分支无效');
    if (!worktreeId) throw new Error('模型对比工作树标识无效');
    const detail = await dependencies.inspectManagedWorktree(worktreeId);
    if (String(detail.childConversationId) !== sessionId) {
      throw new Error('工作树与模型对比分支不匹配');
    }
    await cleanupBranches([{ sessionId, worktreeId }]);
    return { ok: true, sessionId };
  }

  return { adopt, discard, snapshot, start };
}

const service = createModelComparisonService();

module.exports = {
  MAX_ANSWER_CHARS,
  MAX_PROMPT_CHARS,
  createModelComparisonService,
  adoptModelComparisonBranch: (input) => service.adopt(input),
  discardModelComparisonBranch: (input) => service.discard(input),
  modelComparisonSnapshot: (input) => service.snapshot(input),
  startModelComparison: (input) => service.start(input),
};
