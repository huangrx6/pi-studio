const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-builtins-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const {
  BUILTIN_MANIFESTS,
  createFilesystemTools,
  createStudioBuiltins,
  resolveWorkspacePath,
  walkFiles,
} = require('../../electron/services/studio-builtins.cjs');
const {
  normalizeManifest,
} = require('../../electron/core/extension-manifest.cjs');
const { setSubagentConfig } = require('../../electron/core/app-settings.cjs');
const { closeStudioDatabase } = require('../../electron/core/studio-db.cjs');

function schemaFactory() {
  return new Proxy({}, {
    get: () => (...args) => ({ args }),
  });
}

function fakeDurable(configured) {
  return {
    ToolTask: { name: 'ToolTask' },
    LiveDoc: { kind: 'pi.live' },
    defineDoc: (definition) => definition,
    defineTask: (definition) => definition,
    defineTool: (definition) => definition,
    defineExtension: (definition) => definition,
    section: (name, render, options) => ({ name, render, options }),
    hook: (name, handler) => ({ name, handler }),
    configure: async (tx, id, change) => {
      configured.push({ tx, id, change });
    },
  };
}

function fakeDocuments() {
  const values = new Map();
  return {
    read(token, id) {
      const key = `${token.kind}:${id}`;
      if (!values.has(key)) values.set(key, token.initial());
      return values.get(key);
    },
    doc(token, id) {
      return this.read(token, id);
    },
    inspect(token, id) {
      return values.get(`${token.kind}:${id}`);
    },
  };
}

function docApi(documents, parentConversationId) {
  return {
    conversationId: parentConversationId,
    now: () => 1_700_000_000_000,
    snapshot: async (token, id) => documents.read(token, id),
  };
}

function todoApi(documents, conversationId, taskId) {
  return {
    ...docApi(documents, conversationId),
    taskId,
    commit: async (callback) => callback({
      doc: (token, id) => documents.doc(token, id),
    }),
  };
}

function publicBuiltinManifest(manifest) {
  const {
    runtimeName: _runtimeName,
    runtimeNames: _runtimeNames,
    ...publicFields
  } = manifest;
  return {
    format: 1,
    ...publicFields,
    runtime: { durableEntry: '' },
  };
}

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('the todo built-in persists plans, lifecycle state, dependencies, and replay idempotency', async () => {
  const durable = fakeDurable([]);
  const builtins = createStudioBuiltins({
    durable,
    piAi: {
      Type: schemaFactory(),
      getSupportedThinkingLevels: () => ['off', 'low', 'medium', 'high'],
    },
    codingTools: { name: 'coding-tools', tools: [] },
    toolSearch: { name: 'tool-search', tools: [] },
  });
  const extension = builtins.get('builtin:studio-todo');
  assert.equal(extension.name, 'studio-todo');
  const tool = extension.tools.find((item) => item.name === 'todo');
  assert.ok(tool);

  const documents = fakeDocuments();
  const conversationId = 71;
  const created = await tool.execute({
    action: 'createMany',
    items: [
      { subject: 'Inspect the current behavior' },
      { subject: 'Implement the fix', activeForm: 'Implementing the fix' },
    ],
  }, todoApi(documents, conversationId, 1001), {});

  assert.equal(created.details.nextId, 3);
  assert.deepEqual(
    created.details.tasks.map((task) => [task.id, task.subject, task.status]),
    [
      [1, 'Inspect the current behavior', 'pending'],
      [2, 'Implement the fix', 'pending'],
    ],
  );
  assert.equal(documents.inspect({ kind: 'studio.todo' }, conversationId).lastMutationTaskId, 1001);

  // A replayed tool task returns the current snapshot instead of creating duplicates.
  const replayed = await tool.execute({
    action: 'createMany',
    items: [
      { subject: 'Inspect the current behavior' },
      { subject: 'Implement the fix', activeForm: 'Implementing the fix' },
    ],
  }, todoApi(documents, conversationId, 1001), {});
  assert.equal(replayed.details.tasks.length, 2);

  await tool.execute(
    { action: 'update', id: 2, blockedBy: [1] },
    todoApi(documents, conversationId, 1002),
    {},
  );
  await assert.rejects(
    tool.execute(
      { action: 'start', id: 2 },
      todoApi(documents, conversationId, 1003),
      {},
    ),
    /阻塞/,
  );

  await tool.execute(
    { action: 'start', id: 1 },
    todoApi(documents, conversationId, 1004),
    {},
  );
  const completed = await tool.execute(
    { action: 'complete', id: 1 },
    todoApi(documents, conversationId, 1005),
    {},
  );
  assert.equal(completed.details.tasks[0].status, 'completed');

  await tool.execute(
    { action: 'start', id: 2 },
    todoApi(documents, conversationId, 1006),
    {},
  );
  await assert.rejects(
    tool.execute(
      { action: 'update', id: 1, blockedBy: [2] },
      todoApi(documents, conversationId, 1007),
      {},
    ),
    /循环/,
  );

  const listed = await tool.execute(
    { action: 'list' },
    todoApi(documents, conversationId, 1008),
    {},
  );
  assert.match(listed.output[0].text, /进度 1\/2/);
  assert.equal(listed.details.tasks[1].blockedBy[0], 1);
});

test('a task-owned subagent is configured inside the creating transaction', async () => {
  const configured = [];
  const durable = fakeDurable(configured);
  const piAi = {
    Type: schemaFactory(),
    getSupportedThinkingLevels: () => ['off', 'low', 'medium', 'high'],
  };
  const workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  setSubagentConfig('user', '', {
    defaultModel: 'child/fast',
    defaultThinking: 'high',
    maxThinking: 'high',
    allowedTools: ['read', 'workspace_only', 'subagent'],
  });

  const builtins = createStudioBuiltins({
    durable,
    piAi,
    codingTools: { name: 'coding-tools', tools: [] },
    toolSearch: { name: 'tool-search', tools: [] },
  });
  const subagents = [...builtins.values()]
    .find((extension) => extension.name === 'studio-subagents');
  const tool = subagents.tools.find((item) => item.name === 'subagent');
  assert.ok(tool);

  const created = [];
  const documents = fakeDocuments();
  const answerEntry = {
    kind: 'pi.assistant',
    model: [{
      role: 'assistant',
      content: [{ type: 'text', text: 'child result' }],
    }],
  };
  const api = {
    ...docApi(documents, 12),
    taskId: 41,
    models: {
      getModel(provider, id) {
        return provider === 'child' && id === 'fast'
          ? { provider, id, name: 'Fast' }
          : undefined;
      },
    },
    agent: async () => ({
      cwd: workspace,
      tools: [{ name: 'read' }, { name: 'grep' }, { name: 'subagent' }],
    }),
    commit: async (callback) => {
      const tx = {
        doc: (token, id) => documents.doc(token, id),
        entry: async (id) => id === 88 ? answerEntry : undefined,
        scanConversations: async () => ({ items: [] }),
        createConversation: async (options) => {
          created.push(options);
          return { id: 77 };
        },
      };
      return callback(tx);
    },
    details: async () => {},
    conversation: async () => ({
      submit: async () => ({
        id: 9,
        wait: async () => ({ status: 'done', type: 'input', answer: 88 }),
      }),
    }),
  };

  const result = await tool.execute(
    { task: 'Inspect the failing module.', instructions: 'Report only verified facts.' },
    api,
    {},
  );

  assert.deepEqual(created, [{ ownership: { kind: 'task', taskId: 41 } }]);
  assert.equal(configured.length, 1);
  assert.equal(configured[0].id, 77);
  assert.deepEqual(configured[0].change.model, { provider: 'child', modelId: 'fast' });
  assert.equal(configured[0].change.thinkingLevel, 'high');
  assert.equal(configured[0].change.extensions[0].name, 'studio-subagent-channel');
  assert.deepEqual(configured[0].change.modelTools.map((item) => item.name), ['read', 'contact_supervisor']);
  assert.deepEqual(configured[0].change.tools.map((item) => item.name), ['read', 'contact_supervisor']);
  assert.match(configured[0].change.instructions, /^Report only verified facts\./);
  assert.match(configured[0].change.instructions, /Cannot spawn children|spawn children/);
  assert.equal(result.output[0].text, 'child result');
  const registry = documents.inspect({ kind: 'studio.subagents' }, 12);
  assert.equal(registry.agents['foreground-41'].lastStatus, 'completed');
});

test('child tools preserve the parent model and nested callable boundaries', async () => {
  const configured = [];
  const durable = fakeDurable(configured);
  const workspace = path.join(temporary, 'callable-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  setSubagentConfig('user', '', {
    defaultModel: '',
    defaultThinking: '',
    maxThinking: '',
    allowedTools: ['read', 'nested_tool'],
    backgroundEnabled: true,
    supervisorEnabled: false,
  });

  const builtins = createStudioBuiltins({
    durable,
    piAi: {
      Type: schemaFactory(),
      getSupportedThinkingLevels: () => ['off', 'low', 'medium', 'high'],
    },
    codingTools: { name: 'coding-tools', tools: [] },
    toolSearch: { name: 'tool-search', tools: [] },
  });
  const tool = builtins.get('builtin:studio-subagents')
    .tools.find((item) => item.name === 'subagent');
  const documents = fakeDocuments();
  const answerEntry = {
    kind: 'pi.assistant',
    model: [{
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    }],
  };

  await tool.execute({ task: 'Use a nested tool.' }, {
    ...docApi(documents, 15),
    taskId: 42,
    agent: async () => ({
      cwd: workspace,
      tools: [{ name: 'read' }, { name: 'grep' }, { name: 'subagent' }],
      callable: [
        { name: 'read' },
        { name: 'grep' },
        { name: 'nested_tool' },
        { name: 'subagent' },
      ],
    }),
    commit: async (callback) => callback({
      doc: (token, id) => documents.doc(token, id),
      entry: async (id) => id === 79 ? answerEntry : undefined,
      scanConversations: async () => ({ items: [] }),
      createConversation: async () => ({ id: 78 }),
    }),
    details: async () => {},
    conversation: async () => ({
      submit: async () => ({
        id: 10,
        wait: async () => ({ status: 'done', type: 'input', answer: 79 }),
      }),
    }),
  }, {});

  assert.deepEqual(
    configured[0].change.tools.map((item) => item.name),
    ['read', 'nested_tool'],
  );
  assert.deepEqual(
    configured[0].change.modelTools.map((item) => item.name),
    ['read'],
  );
});

test('subagent cancellation is checked before and after the owned child settles', async () => {
  const configured = [];
  const durable = fakeDurable(configured);
  setSubagentConfig('user', '', {
    defaultModel: '',
    defaultThinking: '',
    maxThinking: '',
    allowedTools: ['read'],
  });
  const builtins = createStudioBuiltins({
    durable,
    piAi: {
      Type: schemaFactory(),
      getSupportedThinkingLevels: () => ['off', 'low', 'medium', 'high'],
    },
    codingTools: { name: 'coding-tools', tools: [] },
    toolSearch: { name: 'tool-search', tools: [] },
  });
  const tool = [...builtins.values()]
    .find((extension) => extension.name === 'studio-subagents')
    .tools.find((item) => item.name === 'subagent');
  const controller = new AbortController();
  let submitted = false;
  const documents = fakeDocuments();

  const execution = tool.execute({ task: 'wait for cancellation' }, {
    ...docApi(documents, 13),
    taskId: 91,
    models: { getModel: () => undefined },
    agent: async () => ({ cwd: temporary, tools: [{ name: 'read' }] }),
    commit: async (callback) => callback({
      doc: (token, id) => documents.doc(token, id),
      scanConversations: async () => ({ items: [] }),
      createConversation: async () => ({ id: 92 }),
    }),
    details: async () => {},
    conversation: async () => ({
      submit: async () => {
        submitted = true;
        return {
          id: 93,
          wait: async () => {
            controller.abort(new Error('parent aborted'));
            return { status: 'unanswered' };
          },
        };
      },
    }),
  }, { abortSignal: controller.signal });

  await assert.rejects(execution, /parent aborted/);
  assert.equal(submitted, true);
  const registry = documents.inspect({ kind: 'studio.subagents' }, 13);
  assert.equal(registry.agents['foreground-91'].lastStatus, 'stopped');
});

test('a foreground subagent write failure records the failed task outcome', async () => {
  const configured = [];
  const durable = fakeDurable(configured);
  setSubagentConfig('user', '', {
    defaultModel: '',
    defaultThinking: '',
    maxThinking: '',
    allowedTools: ['read'],
  });
  const builtins = createStudioBuiltins({
    durable,
    piAi: {
      Type: schemaFactory(),
      getSupportedThinkingLevels: () => ['off', 'low', 'medium', 'high'],
    },
    codingTools: { name: 'coding-tools', tools: [] },
    toolSearch: { name: 'tool-search', tools: [] },
  });
  const tool = [...builtins.values()]
    .find((extension) => extension.name === 'studio-subagents')
    .tools.find((item) => item.name === 'subagent');
  const documents = fakeDocuments();

  const execution = tool.execute({ task: 'fail inside the child' }, {
    ...docApi(documents, 14),
    taskId: 94,
    models: { getModel: () => undefined },
    agent: async () => ({ cwd: temporary, tools: [{ name: 'read' }] }),
    commit: async (callback) => callback({
      doc: (token, id) => documents.doc(token, id),
      scanConversations: async () => ({ items: [] }),
      createConversation: async () => ({ id: 95 }),
    }),
    details: async () => {},
    conversation: async () => ({
      submit: async () => ({
        id: 96,
        wait: async () => {
          throw new Error('child write failed');
        },
      }),
    }),
  }, {});

  await assert.rejects(execution, /child write failed/);
  const registry = documents.inspect({ kind: 'studio.subagents' }, 14);
  assert.equal(registry.agents['foreground-94'].lastStatus, 'failed');
  assert.equal(registry.agents['foreground-94'].lastError, 'child write failed');
});

test('parallel subagent tool calls own separate conversations while replay stays idempotent', async () => {
  const durable = fakeDurable([]);
  setSubagentConfig('user', '', {
    defaultModel: '',
    defaultThinking: '',
    maxThinking: '',
    allowedTools: ['read'],
  });
  const builtins = createStudioBuiltins({
    durable,
    piAi: {
      Type: schemaFactory(),
      getSupportedThinkingLevels: () => ['off', 'low', 'medium', 'high'],
    },
    codingTools: { name: 'coding-tools', tools: [] },
    toolSearch: { name: 'tool-search', tools: [] },
  });
  const tool = [...builtins.values()]
    .find((extension) => extension.name === 'studio-subagents')
    .tools.find((item) => item.name === 'subagent');
  const owned = new Map();
  const documents = fakeDocuments();
  let nextConversationId = 100;

  function apiFor(taskId, result) {
    const answerEntry = {
      kind: 'pi.assistant',
      model: [{
        role: 'assistant',
        content: [{ type: 'text', text: result }],
      }],
    };
    return {
      ...docApi(documents, 600 + taskId),
      taskId,
      models: { getModel: () => undefined },
      agent: async () => ({ cwd: temporary, tools: [{ name: 'read' }] }),
      commit: async (callback) => callback({
        doc: (token, id) => documents.doc(token, id),
        entry: async (id) => id === 900 + taskId ? answerEntry : undefined,
        scanConversations: async ({ ownerTaskId }) => ({
          items: owned.has(ownerTaskId) ? [{ id: owned.get(ownerTaskId) }] : [],
        }),
        createConversation: async ({ ownership }) => {
          const id = nextConversationId;
          nextConversationId += 1;
          owned.set(ownership.taskId, id);
          return { id };
        },
      }),
      details: async () => {},
      conversation: async (id) => ({
        submit: async () => ({
          id: `${id}:submission`,
          wait: async () => ({ status: 'done', type: 'input', answer: 900 + taskId }),
        }),
      }),
    };
  }

  const [left, right] = await Promise.all([
    tool.execute({ task: 'left' }, apiFor(501, 'left result'), {}),
    tool.execute({ task: 'right' }, apiFor(502, 'right result'), {}),
  ]);
  assert.equal(left.output[0].text, 'left result');
  assert.equal(right.output[0].text, 'right result');
  assert.notEqual(left.details.conversationId, right.details.conversationId);
  assert.equal(owned.size, 2);

  const replay = await tool.execute({ task: 'left again' }, apiFor(501, 'replayed'), {});
  assert.equal(replay.details.conversationId, left.details.conversationId);
  assert.equal(owned.size, 2);
});

test('a subagent allowlist with no available tools fails clearly before creating a child', async () => {
  const durable = fakeDurable([]);
  setSubagentConfig('user', '', {
    defaultModel: '',
    defaultThinking: '',
    maxThinking: '',
    allowedTools: ['removed-extension-tool'],
  });
  const builtins = createStudioBuiltins({
    durable,
    piAi: { Type: schemaFactory(), getSupportedThinkingLevels: () => [] },
    codingTools: { name: 'coding-tools', tools: [] },
    toolSearch: { name: 'tool-search', tools: [] },
  });
  const tool = [...builtins.values()]
    .find((extension) => extension.name === 'studio-subagents')
    .tools.find((item) => item.name === 'subagent');
  let committed = false;
  const documents = fakeDocuments();

  await assert.rejects(
    tool.execute({ task: 'inspect' }, {
      ...docApi(documents, 14),
      taskId: 77,
      agent: async () => ({ cwd: temporary, tools: [{ name: 'read' }] }),
      commit: async () => {
        committed = true;
      },
    }, {}),
    /白名单与父 Agent 当前工具没有交集/,
  );
  assert.equal(committed, false);
});

test('background subagents use a conversation-owned anchor, reporter, supervisor identity and wait projection', async () => {
  const configured = [];
  const durable = fakeDurable(configured);
  setSubagentConfig('user', '', {
    defaultModel: '',
    defaultThinking: '',
    maxThinking: '',
    allowedTools: ['read'],
    backgroundEnabled: true,
    defaultMode: 'background',
    supervisorEnabled: true,
    maxConcurrent: 3,
    maxSpawns: 8,
    waitTimeoutMs: 2_000,
  });
  const builtins = createStudioBuiltins({
    durable,
    piAi: {
      Type: schemaFactory(),
      getSupportedThinkingLevels: () => ['off', 'low', 'medium', 'high'],
    },
    codingTools: { name: 'coding-tools', tools: [] },
    toolSearch: { name: 'tool-search', tools: [] },
  });
  const parent = builtins.get('builtin:studio-subagents');
  const channelExtension = builtins.get('builtin:studio-subagent-channel');
  const subagent = parent.tools.find((tool) => tool.name === 'subagent');
  const stop = parent.tools.find((tool) => tool.name === 'subagent_stop');
  const supervisor = parent.tools.find((tool) => tool.name === 'subagent_supervisor');
  const wait = parent.tools.find((tool) => tool.name === 'bg_wait');
  const contact = channelExtension.tools.find((tool) => tool.name === 'contact_supervisor');
  const documents = fakeDocuments();
  const tasks = new Map();
  const createdConversations = [];
  const parentSubmissions = [];
  const aborts = [];
  let nextTaskId = 700;
  let nextConversationId = 900;

  async function createTask(task, input, options) {
    const id = ++nextTaskId;
    tasks.set(id, {
      id,
      kind: task.name,
      input,
      options,
      state: { status: 'pending' },
    });
    return id;
  }

  function txFor() {
    return {
      doc: (token, id) => documents.doc(token, id),
      task: async (id) => tasks.get(Number(id)),
      createTask,
      scanConversations: async () => ({ items: [] }),
      createConversation: async (options) => {
        const id = ++nextConversationId;
        createdConversations.push({ id, options });
        return { id };
      },
    };
  }

  function apiFor(taskId, conversationId) {
    return {
      ...docApi(documents, conversationId),
      taskId,
      models: { getModel: () => undefined },
      agent: async () => ({
        cwd: temporary,
        tools: [{ name: 'read' }, { name: 'subagent' }, { name: 'bg_wait' }],
      }),
      commit: async (callback) => callback(txFor()),
      details: async () => {},
      getTask: async (id) => tasks.get(Number(id)),
      waitForTask: async (id) => {
        const task = tasks.get(Number(id));
        if (task) task.state = { status: 'terminal', outcome: { status: 'completed', result: null } };
        return { id, state: tasks.get(Number(id))?.state };
      },
      conversation: async (id) => {
        if (id === 501 || id === 901) {
          return {
            abort: async (_context, options) => {
              aborts.push({ id, options });
            },
            submit: async (submission) => {
              parentSubmissions.push(submission);
              return { id: 9_999, wait: async () => ({ status: 'done' }) };
            },
          };
        }
        return {
          abort: async (_context, options) => {
            aborts.push({ id, options });
          },
          submit: async () => ({ id: 8_888, wait: async () => ({ status: 'done' }) }),
        };
      },
    };
  }

  const spawned = await subagent.execute(
    { action: 'spawn', name: 'reader', message: 'Inspect the parser.' },
    apiFor(401, 501),
    {},
  );
  assert.match(spawned.output[0].text, /后台启动 reader/);
  const anchor = tasks.get(701);
  const reporter = tasks.get(702);
  assert.equal(anchor.kind, 'studio.subagent-anchor');
  assert.deepEqual(anchor.options, {
    ownership: { kind: 'conversation' },
    background: true,
  });
  assert.equal(reporter.kind, 'studio.subagent-reporter');
  assert.deepEqual(createdConversations[0], {
    id: 901,
    options: { ownership: { kind: 'task', taskId: 701 } },
  });
  assert.deepEqual(configured[0].change.modelTools.map((tool) => tool.name), [
    'read',
    'contact_supervisor',
  ]);
  assert.equal(configured[0].change.extensions[0].name, 'studio-subagent-channel');

  const sent = await subagent.execute(
    { action: 'send', name: 'reader', message: 'Also check errors.' },
    apiFor(402, 501),
    {},
  );
  assert.match(sent.output[0].text, /自动回传/);
  assert.equal(tasks.get(703).input.name, 'reader');
  assert.equal(tasks.get(703).input.followUp, true);

  const waited = await wait.execute(
    { runId: '703', timeoutMs: 1_000 },
    apiFor(403, 501),
    {},
  );
  assert.match(waited.output[0].text, /已结束/);
  assert.equal(waited.details.timedOut, false);

  const childApi = apiFor(404, 901);
  await contact.execute(
    { question: 'Should I modify tests too?' },
    childApi,
    {},
  );
  assert.match(parentSubmissions[0].content, /Should I modify tests too/);
  assert.equal(parentSubmissions[0].requestId, 'subagent-supervisor-request:supervisor:404');

  const pending = await supervisor.execute(
    { action: 'pending' },
    apiFor(405, 501),
    {},
  );
  assert.match(pending.output[0].text, /reader: Should I modify tests too/);
  const replied = await supervisor.execute(
    {
      action: 'reply',
      replyTo: 'supervisor:404',
      message: 'Yes, add one focused test.',
    },
    apiFor(406, 501),
    {},
  );
  assert.match(replied.output[0].text, /已回复 reader/);
  assert.equal(tasks.get(704).input.followUp, true);
  assert.match(tasks.get(704).input.message, /Yes, add one focused test/);

  const stopped = await stop.execute(
    { name: 'reader' },
    apiFor(407, 501),
    {},
  );
  assert.match(stopped.output[0].text, /已停止 reader/);
  assert.deepEqual(aborts, [{
    id: 901,
    options: { background: true },
  }]);
});

test('consecutive background reporters do not read task tables after the registry write', async () => {
  const durable = fakeDurable([]);
  setSubagentConfig('user', '', {
    defaultModel: '',
    defaultThinking: '',
    maxThinking: '',
    allowedTools: ['read'],
    backgroundEnabled: true,
    supervisorEnabled: false,
    maxConcurrent: 4,
    maxSpawns: 8,
  });
  const builtins = createStudioBuiltins({
    durable,
    piAi: {
      Type: schemaFactory(),
      getSupportedThinkingLevels: () => ['off', 'low', 'medium', 'high'],
    },
    codingTools: { name: 'coding-tools', tools: [] },
    toolSearch: { name: 'tool-search', tools: [] },
  });
  const subagent = builtins.get('builtin:studio-subagents')
    .tools.find((tool) => tool.name === 'subagent');
  const documents = fakeDocuments();
  const tasks = new Map();
  let nextTaskId = 700;
  let nextConversationId = 900;

  function strictTransaction() {
    let wrote = false;
    const write = (_method, value) => {
      wrote = true;
      return value;
    };
    const read = (method, value) => {
      if (wrote) throw new Error(`Tx.${method}() cannot read tables after the first table write`);
      return value;
    };
    return {
      doc(token, id) {
        return write('doc', documents.doc(token, id));
      },
      task(id) {
        return read('task', tasks.get(Number(id)));
      },
      scanTasks(query, limit) {
        return read('scanTasks', {
          items: [...tasks.values()].slice(0, limit).filter((task) => (
            (!query.kind || task.kind === query.kind)
            && (query.conversationId === undefined || task.conversationId === query.conversationId)
          )),
        });
      },
      scanConversations() {
        return read('scanConversations', { items: [] });
      },
      async createConversation({ ownership }) {
        const id = ++nextConversationId;
        wrote = true;
        return { id, ownership };
      },
      async createTask(task, input) {
        const id = ++nextTaskId;
        wrote = true;
        tasks.set(id, {
          id,
          kind: task.name,
          input,
          conversationId: 501,
          background: true,
          state: { status: 'pending' },
        });
        return id;
      },
    };
  }

  function apiFor(taskId) {
    return {
      ...docApi(documents, 501),
      taskId,
      models: { getModel: () => undefined },
      agent: async () => ({ cwd: temporary, tools: [{ name: 'read' }] }),
      commit: async (callback) => callback(strictTransaction()),
      details: async () => {},
    };
  }

  await subagent.execute(
    { action: 'spawn', name: 'zhengzhou', message: 'Check Zhengzhou.' },
    apiFor(801),
    {},
  );
  await subagent.execute(
    { action: 'spawn', name: 'beijing', message: 'Check Beijing.' },
    apiFor(802),
    {},
  );

  const registry = documents.inspect({ kind: 'studio.subagents' }, 501);
  assert.equal(registry.agents.zhengzhou.lastStatus, 'running');
  assert.equal(registry.agents.beijing.lastStatus, 'running');
  assert.equal(
    Object.values(registry.reporters).filter((reporter) => reporter.active).length,
    2,
  );
});

test('built-in responsibilities use independent runtimes and explicit dependency tiers', () => {
  const durable = fakeDurable([]);
  const piAi = {
    Type: schemaFactory(),
    getSupportedThinkingLevels: () => ['off', 'low', 'medium', 'high'],
  };
  const builtins = createStudioBuiltins({
    durable,
    piAi,
    codingTools: { name: 'coding-tools', tools: [] },
    toolSearch: { name: 'tool-search', tools: [] },
  });

  assert.deepEqual(
    [...builtins.keys()],
    BUILTIN_MANIFESTS.map((manifest) => `builtin:${manifest.id}`),
  );
  assert.deepEqual(
    [...builtins.values()].map((extension) => extension.name).sort(),
    BUILTIN_MANIFESTS.map((manifest) => manifest.runtimeName).sort(),
  );
  assert.equal(
    BUILTIN_MANIFESTS.find((manifest) => manifest.id === 'studio-permissions').tier,
    'core',
  );
  assert.equal(
    BUILTIN_MANIFESTS.filter((manifest) => manifest.tier === 'core').length,
    1,
  );
  assert.equal(
    BUILTIN_MANIFESTS.find((manifest) => manifest.id === 'studio-metrics').tier,
    'optional',
  );
  assert.deepEqual(
    BUILTIN_MANIFESTS.find((manifest) => manifest.id === 'studio-permissions').permissions,
    ['agent.hooks'],
  );
  for (const manifest of BUILTIN_MANIFESTS) {
    normalizeManifest(publicBuiltinManifest(manifest), `builtin:${manifest.id}`, 'builtin');
  }
  const metrics = normalizeManifest(
    publicBuiltinManifest(BUILTIN_MANIFESTS.find((manifest) => manifest.id === 'studio-metrics')),
    'builtin:studio-metrics',
    'builtin',
  );
  assert.deepEqual(metrics.permissions, ['ui.panels', 'ui.data']);
  assert.deepEqual(metrics.contributes.dataSources.map((item) => item.id), ['live', 'summary']);
  assert.equal(
    metrics.contributes.panels[0].content[0].sourceId,
    'builtin:studio-metrics/live',
  );
  assert.equal(
    metrics.contributes.panels[1].content[0].sourceId,
    'builtin:studio-metrics/summary',
  );
  const known = new Set(BUILTIN_MANIFESTS.map((manifest) => `builtin:${manifest.id}`));
  for (const manifest of BUILTIN_MANIFESTS) {
    for (const requirement of manifest.requires || []) {
      assert.ok(known.has(requirement), `${manifest.id} references unknown ${requirement}`);
    }
  }
});

test('filesystem discovery keeps symlink targets inside the workspace', async (t) => {
  const outside = path.join(temporary, 'outside');
  const workspace = path.join(temporary, 'symlink-workspace');
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret', 'utf8');
  fs.writeFileSync(path.join(workspace, 'inside.txt'), 'inside', 'utf8');
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'leak.txt'));
  } catch (error) {
    t.skip(`当前环境不能创建符号链接：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const files = await walkFiles(workspace, '.', { hidden: true, maxResults: 100 });
  assert.ok(files.some((file) => path.basename(file) === 'inside.txt'));
  assert.ok(files.every((file) => path.basename(file) !== 'leak.txt'));
  await assert.rejects(
    resolveWorkspacePath(workspace, 'leak.txt'),
    /真实位置必须位于当前工作区内/,
  );
});

test('filesystem find and grep handle filters, binary files, regex errors and limits', async () => {
  const workspace = path.join(temporary, 'filesystem-tools');
  fs.mkdirSync(path.join(workspace, 'later'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'first.txt'), 'not a match', 'utf8');
  fs.writeFileSync(path.join(workspace, 'later', 'needle.txt'), 'alpha in nested file', 'utf8');
  fs.writeFileSync(path.join(workspace, '.hidden.txt'), 'alpha in hidden file', 'utf8');
  fs.writeFileSync(
    path.join(workspace, 'binary.bin'),
    Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('alpha')]),
  );

  const durable = fakeDurable([]);
  const extension = createFilesystemTools(durable, { Type: schemaFactory() });
  const find = extension.tools.find((item) => item.name === 'find');
  const grep = extension.tools.find((item) => item.name === 'grep');
  const api = {
    agent: async () => ({ cwd: workspace }),
  };

  const found = await find.execute({ query: 'needle', maxResults: 1 }, api, {});
  assert.equal(found.output[0].text, path.join('later', 'needle.txt'));

  const searched = await grep.execute({ pattern: 'alpha', maxResults: 1 }, api, {});
  assert.equal(searched.output[0].text, '.hidden.txt:1:alpha in hidden file');
  assert.doesNotMatch(searched.output[0].text, /binary\.bin/);

  fs.writeFileSync(
    path.join(workspace, 'many.txt'),
    Array.from({ length: 1_105 }, () => 'alpha').join('\n'),
    'utf8',
  );
  const bounded = await grep.execute(
    { pattern: 'alpha', path: 'many.txt', maxResults: 1_000_000 },
    api,
    {},
  );
  assert.equal(bounded.output[0].text.split('\n').length, 1_000);

  await assert.rejects(
    grep.execute({ pattern: '[' }, api, {}),
    /无效的正则表达式/,
  );
  await assert.rejects(
    grep.execute({ pattern: 'a'.repeat(513) }, api, {}),
    /不能超过 512 个字符/,
  );

  fs.writeFileSync(
    path.join(workspace, 'long-line.txt'),
    `alpha${'x'.repeat(9_000)}`,
    'utf8',
  );
  const skipped = await grep.execute(
    { pattern: 'alpha', path: 'long-line.txt' },
    api,
    {},
  );
  assert.match(skipped.output[0].text, /Skipped 1 line longer than 8192 characters/);
});

test('grep interrupts catastrophic regular expressions in an isolated worker', async () => {
  const workspace = path.join(temporary, 'grep-timeout');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'adversarial.txt'),
    `${'a'.repeat(4_000)}!`,
    'utf8',
  );
  const extension = createFilesystemTools(
    fakeDurable([]),
    { Type: schemaFactory() },
    { grepTimeoutMs: 100 },
  );
  const grep = extension.tools.find((item) => item.name === 'grep');
  const started = Date.now();
  await assert.rejects(
    grep.execute(
      { pattern: '^(a+)+$', path: 'adversarial.txt' },
      { agent: async () => ({ cwd: workspace }) },
      {},
    ),
    /执行超过|已终止/,
  );
  assert.ok(Date.now() - started < 1_500, 'the main process must return promptly');
});
