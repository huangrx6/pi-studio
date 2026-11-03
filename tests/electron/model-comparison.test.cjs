const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createModelComparisonService,
} = require('../../electron/services/model-comparison.cjs');

function branchIdentity(index) {
  return {
    label: index === 0 ? 'Fast' : 'Strong',
    modelRef: index === 0 ? 'faux/fast' : 'faux/strong',
    thinkingLevel: index === 0 ? 'medium' : 'high',
  };
}

function fixture(overrides = {}) {
  const calls = {
    abort: [],
    action: [],
    apply: [],
    configuredCwd: [],
    configuredModel: [],
    discard: [],
    submitted: [],
  };
  const pages = new Map();
  const worktrees = new Map();
  let nextId = 40;
  const dependencies = {
    conversationPage: async (id, options) => {
      if (id === 'parent') return { id, cwd: '/repo', running: false, title: 'Parent' };
      if (pages.has(String(id))) return pages.get(String(id));
      return undefined;
    },
    conversationAction: async (input) => {
      calls.action.push(input);
      if (input.action === 'fork') {
        nextId += 1;
        return { id: String(nextId) };
      }
      return { ok: true };
    },
    createManagedWorktree: async (input) => {
      const row = {
        id: input.id,
        childConversationId: '',
        path: `/managed/${input.id}`,
        status: 'active',
      };
      worktrees.set(input.id, row);
      return row;
    },
    bindManagedWorktree: (id, childConversationId) => {
      const row = worktrees.get(id);
      row.childConversationId = String(childConversationId);
      return row;
    },
    discardManagedWorktree: async (id) => {
      calls.discard.push(id);
      return { ok: true };
    },
    completeManagedWorktree: async (id, { status }) => {
      const row = worktrees.get(id);
      if (row) row.status = status;
      return row;
    },
    inspectManagedWorktree: async (id) => {
      const row = worktrees.get(id);
      return {
        ...row,
        changedFiles: 1,
        files: [{ path: 'result.txt', status: 'added', added: 1, removed: 0, binary: false }],
        sizeBytes: 12,
        error: '',
        directoryExists: true,
      };
    },
    applyManagedWorktree: async (id) => {
      calls.apply.push(id);
      return { ok: true, changedFiles: 1 };
    },
    configureConversation: async (input) => {
      calls.configuredModel.push(input);
      return {};
    },
    configureConversationAgentCwd: async (id, cwd) => {
      calls.configuredCwd.push({ id, cwd });
      return { ok: true, cwd };
    },
    submitConversation: async (input) => {
      calls.submitted.push(input);
      return { conversationId: input.id, status: 'placed' };
    },
    abortConversation: async (id) => {
      calls.abort.push(id);
      return { ok: true };
    },
    metricTotals: () => ({ requests: 2, tokens: 1_250, cost: 0.0123 }),
    metricRequests: () => [{ tps: 48.5, ttftMs: 420, durationMs: 3_200 }],
    ...overrides,
  };
  return { calls, dependencies, pages, worktrees };
}

test('comparison creates two isolated forks and submits one exact prompt to both', async () => {
  const state = fixture();
  const service = createModelComparisonService(state.dependencies);
  const result = await service.start({
    parentId: 'parent',
    prompt: '  Explain this failure.  ',
    mentions: ['src/app.ts'],
    attachments: ['/tmp/spec.md'],
    images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    branches: [branchIdentity(0), branchIdentity(1)],
  });

  assert.equal(result.branches.length, 2);
  assert.equal(state.calls.submitted.length, 2);
  assert.deepEqual(state.calls.submitted.map((item) => item.text), [
    'Explain this failure.',
    'Explain this failure.',
  ]);
  assert.notEqual(
    state.calls.submitted[0].requestId,
    state.calls.submitted[1].requestId,
  );
  assert.deepEqual(state.calls.submitted.map((item) => item.mentions), [
    ['src/app.ts'],
    ['src/app.ts'],
  ]);
  assert.deepEqual(state.calls.configuredModel.map((item) => item.modelRef), [
    'faux/fast',
    'faux/strong',
  ]);
  assert.deepEqual(state.calls.configuredCwd.map((item) => item.cwd), [
    `/managed/${result.branches[0].worktreeId}`,
    `/managed/${result.branches[1].worktreeId}`,
  ]);
  assert.ok(state.calls.action.some((item) => item.action === 'long-task-clear'));
  assert.ok(state.calls.action.some((item) => item.action === 'rename'));
});

test('comparison rejects duplicate models before creating a fork', async () => {
  const state = fixture();
  const service = createModelComparisonService(state.dependencies);
  await assert.rejects(service.start({
    parentId: 'parent',
    prompt: 'Same question',
    branches: [branchIdentity(0), { ...branchIdentity(1), modelRef: 'faux/fast' }],
  }), /不同的模型/);
  assert.equal(state.calls.action.length, 0);
});

test('a partial submission failure aborts sessions and discards both worktrees', async () => {
  const state = fixture();
  let submissions = 0;
  state.dependencies.submitConversation = async (input) => {
    submissions += 1;
    if (submissions === 2) throw new Error('second branch rejected');
    state.calls.submitted.push(input);
    return { conversationId: input.id, status: 'placed' };
  };
  const service = createModelComparisonService(state.dependencies);
  await assert.rejects(service.start({
    parentId: 'parent',
    prompt: 'Compare safely',
    branches: [branchIdentity(0), branchIdentity(1)],
  }), /second branch rejected/);
  assert.equal(state.calls.abort.length, 2);
  assert.equal(state.calls.action.filter((item) => item.action === 'remove').length, 2);
  assert.equal(state.calls.discard.length, 2);
});

test('snapshot reports isolated changes and adoption applies them before returning cwd', async () => {
  const state = fixture();
  const service = createModelComparisonService(state.dependencies);
  const started = await service.start({
    parentId: 'parent',
    prompt: 'Return a patch',
    branches: [branchIdentity(0), branchIdentity(1)],
  });
  for (const branch of started.branches) {
    state.pages.set(branch.sessionId, {
      id: branch.sessionId,
      cwd: '/repo',
      title: `对比 · ${branch.label}`,
      running: false,
      compacting: false,
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: `${branch.label} answer` }],
        streaming: false,
      }],
    });
  }
  const snapshot = await service.snapshot({ branches: started.branches });
  assert.deepEqual(snapshot.map((item) => item.status), ['completed', 'completed']);
  assert.equal(snapshot[0].metrics.tokens, 1_250);
  assert.equal(snapshot[0].worktreeId, started.branches[0].worktreeId);
  assert.equal(snapshot[0].worktree.changedFiles, 1);

  await service.adopt({
    sessionId: started.branches[0].sessionId,
    worktreeId: started.branches[0].worktreeId,
  });
  assert.deepEqual(state.calls.apply, [started.branches[0].worktreeId]);
  assert.deepEqual(state.calls.configuredCwd.at(-1), {
    id: started.branches[0].sessionId,
    cwd: '/repo',
  });
});

test('cleanup failures are reported and a failed abort preserves the branch', async () => {
  const state = fixture({ abortConversation: async () => { throw new Error('cannot stop'); } });
  const service = createModelComparisonService(state.dependencies);
  const started = await service.start({ parentId: 'parent', prompt: 'test', branches: [branchIdentity(0), branchIdentity(1)] });
  await assert.rejects(service.discard(started.branches[0]), /cannot stop/);
  assert.equal(state.calls.discard.length, 0);
  assert.equal(state.calls.action.some((call) => call.action === 'remove'), false);
});

test('snapshots use public conversation IDs and ignore inherited answers before the new prompt', async () => {
  const state = fixture();
  state.pages.set('public-uuid', {
    cwd: '/repo', running: false,
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'old parent answer' }] },
      { role: 'user', content: 'new prompt' },
    ],
  });
  const ids = [];
  state.dependencies.metricTotals = (id) => { ids.push(id); return { requests: 3, tokens: 30, cost: 0 }; };
  const service = createModelComparisonService(state.dependencies);
  const result = await service.snapshot({ branches: [
    { sessionId: 'public-uuid', modelRef: 'faux/fast' },
    { sessionId: 'missing', modelRef: 'faux/strong' },
  ] });
  assert.deepEqual(ids, ['public-uuid']);
  assert.equal(result[0].status, 'unanswered');
  assert.equal(result[0].answer, undefined);
  assert.equal(result[0].metrics.tokens, 30);
});

test('discarding a branch refuses a worktree owned by another conversation', async () => {
  const state = fixture();
  const service = createModelComparisonService(state.dependencies);
  await assert.rejects(service.discard({
    sessionId: '41',
    worktreeId: 'comparison:other:1',
  }), /不匹配/);
  assert.equal(state.calls.abort.length, 0);
  assert.equal(state.calls.discard.length, 0);
});

test('discarding a branch aborts it, removes the session and deletes its worktree', async () => {
  const state = fixture();
  const service = createModelComparisonService(state.dependencies);
  const started = await service.start({
    parentId: 'parent',
    prompt: 'Discard one result',
    branches: [branchIdentity(0), branchIdentity(1)],
  });
  const branch = started.branches[0];
  assert.deepEqual(await service.discard(branch), {
    ok: true,
    sessionId: branch.sessionId,
  });
  assert.deepEqual(state.calls.abort, [branch.sessionId]);
  assert.ok(state.calls.action.some((item) => (
    item.id === branch.sessionId && item.action === 'remove'
  )));
  assert.deepEqual(state.calls.discard, [branch.worktreeId]);
});
