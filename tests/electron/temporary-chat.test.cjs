const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-temporary-'));
const database = path.join(temporary, 'studio.sqlite');
const attachmentRoot = path.join(temporary, 'attachments');
const jsonlRoot = path.join(temporary, 'sessions');
process.env.PI_STUDIO_DB = database;

const calls = [];
const runtimes = [];
let activeStorage;
let nextId = 1;
let rejectNextSubmission = false;
let model = {
  provider: 'mock',
  id: 'text-model',
  name: 'Text model',
  input: ['text'],
};
let safeExtensionEntries = [];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

class MockStorage {
  constructor() {
    this.kind = 'sqlite';
    this.closed = false;
    activeStorage = this;
    calls.push(['storage', 'create']);
  }

  async submissionByRequest() { return undefined; }

  async close() {
    this.closed = true;
    calls.push(['storage', 'close']);
  }
}

function createMockRuntime() {
  const conversations = [];
  const streams = [];
  const pendingSubmits = [];
  activeStorage = undefined;
  let runtime;
  runtime = {
    context: { name: 'mock-context' },
    cleanupSessionResources(id) { calls.push(['provider', 'release', id]); },
    durable: {
      ProviderDoc: { kind: 'pi.provider' },
      Harness: {
        async open() {
          calls.push(['harness', 'open']);
          return runtime.harness;
        },
      },
      createRegistry() {
        calls.push(['registry', 'create']);
        const installed = new Map();
        return {
          kind: 'mock-registry',
          installed,
          install(extension) {
            calls.push(['registry', 'install', extension.name]);
            installed.set(extension.name, extension);
          },
          uninstall(extension) {
            calls.push(['registry', 'uninstall', extension.name]);
            installed.delete(extension.name);
          },
        };
      },
    },
    harness: {
      async snapshot(doc, id) {
        assert.equal(doc, runtime.durable.ProviderDoc);
        return { sessionId: `provider-${id}` };
      },
      async conversation(id) {
        return conversations.find(conversation => conversation.id === id);
      },
      async createConversation(options) {
            const id = nextId++;
            const conversation = {
              id,
              options,
              aborted: false,
              configured: [],
              submissions: [],
              async configure(change) {
                this.configured.push(structuredClone(change));
                calls.push(['conversation', 'configure', id]);
              },
              async submit(payload) {
                if (rejectNextSubmission) {
                  rejectNextSubmission = false;
                  throw new Error('admission failed');
                }
                this.submissions.push(structuredClone(payload));
                const settlement = deferred();
                pendingSubmits.push({ conversation: this, payload, settlement });
                return {
                  wait: async () => settlement.promise,
                };
              },
              async abort() {
                this.aborted = true;
                calls.push(['conversation', 'abort', id]);
              },
              // 1.5.0：实时状态来自会话视图的序列化 watch。
              async watch() {
                const stream = {
                  id,
                  value: { conversation: { id }, entries: [], docs: {} },
                  started: false,
                  stopped: false,
                  listeners: [],
                  start(listener) {
                    this.started = true;
                    this.listeners.push(listener);
                  },
                  async stop() {
                    this.stopped = true;
                    calls.push(['stream', 'stop', id]);
                  },
                };
                streams.push(stream);
                return stream;
              },
            };
            conversations.push(conversation);
            calls.push(['conversation', 'create', id]);
            return conversation;
      },
      async close() {
        calls.push(['harness', 'close']);
      },
    },
    conversations,
    pendingSubmits,
    streams,
    get storage() {
      return activeStorage;
    },
  };
  runtimes.push(runtime);
  return runtime;
}

let currentRuntime = createMockRuntime();

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '../runtime/durable-storage.cjs') {
    return { openDurableStorage: async (filename, options) => {
      assert.equal(filename, database);
      assert.equal(options.prefix, 'pi_temporary_');
      return new MockStorage();
    } };
  }
  if (request === '../runtime/durable-runtime.cjs') {
    return {
      getDurableRuntime: async () => currentRuntime,
    };
  }
  if (request.endsWith('core/studio-models.cjs')) {
    return {
      getStudioModelsRuntimeSync: () => ({ models: [model] }),
      getStudioModelsRuntime: async () => ({ models: [model] }),
    };
  }
  if (request === './models.cjs') {
    return {
      modelInfo: async () => ({
        modelRef: 'mock/text-model',
        thinkingLevel: 'medium',
      }),
      modelInfoFor: (_model, _cwd, thinkingLevel, modelRef) => ({
        modelRef,
        label: _model.name,
        supportsImages: Array.isArray(_model.input) && _model.input.includes('image'),
        thinkingLevel: thinkingLevel || 'default',
        thinkingLevels: ['default', 'low', 'high'],
        effectiveThinkingLevel: thinkingLevel === 'default' ? 'low' : (thinkingLevel || 'low'),
        defaultThinkingLevel: 'low',
      }),
      runtimeModelFor: () => model,
      splitModelRef: (value) => {
        const slash = String(value || '').indexOf('/');
        if (slash <= 0) return undefined;
        return {
          provider: String(value).slice(0, slash),
          modelId: String(value).slice(slash + 1),
        };
      },
    };
  }
  if (request === './studio-extensions.cjs') {
    return {
      temporarySafeExtensions: () => safeExtensionEntries,
    };
  }
  if (request.endsWith('core/serialize.cjs')) {
    return { serializeMessage: (message) => structuredClone(message) };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const temporaryChat = require('../../electron/main/services/temporary-chat.cjs');

test.after(async () => {
  Module._load = originalLoad;
  await temporaryChat.shutdownTemporaryChats();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('temporary chat rejects images before creating a conversation for a text-only model', async () => {
  await assert.rejects(
    temporaryChat.temporaryPrompt(101, {
      id: 'text-only-image',
      text: '',
      images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
      modelRef: 'mock/text-model',
      thinkingLevel: 'medium',
    }, () => {}),
    /不支持图片/,
  );
  assert.equal(currentRuntime.conversations.length, 0);
  assert.equal(fs.existsSync(database), false);
  assert.equal(fs.existsSync(attachmentRoot), false);
  assert.equal(fs.existsSync(jsonlRoot), false);
});

test('temporary chat uses private Durable storage, supports images, and hot switches models', async () => {
  model = {
    provider: 'mock',
    id: 'vision-model',
    name: 'Vision model',
    input: ['text', 'image'],
  };
  const events = [];
  const first = temporaryChat.temporaryPrompt(202, {
    id: 'vision-chat',
    text: 'describe this',
    images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
    modelRef: 'mock/vision-model',
    thinkingLevel: 'high',
  }, (event) => events.push(event));

  await new Promise((resolve) => setImmediate(resolve));
  const firstSubmit = currentRuntime.pendingSubmits.shift();
  assert.deepEqual(firstSubmit.payload.content, [
    { type: 'text', text: 'describe this' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
  ]);
  assert.equal(firstSubmit.conversation.options.agent.tools.length, 0);
  assert.equal(firstSubmit.conversation.options.agent.cwd, os.tmpdir());
  assert.equal(currentRuntime.storage.kind, 'sqlite');
  assert.equal(fs.existsSync(database), true);
  assert.deepEqual(temporaryChat.temporaryHistory().map(chat => chat.title), ['describe this']);
  assert.equal(fs.existsSync(attachmentRoot), false);
  assert.equal(fs.existsSync(jsonlRoot), false);

  firstSubmit.settlement.resolve({ status: 'completed' });
  await first;
  assert.deepEqual(events.at(-1), { type: 'done' });

  model = {
    provider: 'mock',
    id: 'text-model-3',
    name: 'Text model 3',
    input: ['text'],
  };
  await assert.rejects(
    temporaryChat.temporaryPrompt(202, {
      id: 'vision-chat',
      text: 'continue after an image',
      images: [],
      modelRef: 'mock/text-model-3',
      thinkingLevel: 'low',
    }, () => {}),
    /不支持图片/,
  );

  model = {
    provider: 'mock',
    id: 'vision-model-2',
    name: 'Vision model 2',
    input: ['text', 'image'],
  };
  const second = temporaryChat.temporaryPrompt(202, {
    id: 'vision-chat',
    text: 'continue',
    images: [],
    modelRef: 'mock/vision-model-2',
    thinkingLevel: 'low',
  }, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  const secondSubmit = currentRuntime.pendingSubmits.shift();
  assert.deepEqual(secondSubmit.conversation.configured.at(-1), {
    model: { provider: 'mock', modelId: 'vision-model-2' },
    thinkingLevel: 'low',
  });
  secondSubmit.settlement.resolve({ status: 'completed' });
  await second;
  await temporaryChat.closeTemporary(202, 'vision-chat');
  await temporaryChat.shutdownTemporaryChats();
  assert.equal(currentRuntime.storage.closed, true);
  currentRuntime = createMockRuntime();
});

test('temporary model switching resolves the target model without inheriting the saved chat level', async () => {
  model = {
    provider: 'mock',
    id: 'vision-model-3',
    name: 'Vision model 3',
    input: ['text', 'image'],
  };
  const selection = await temporaryChat.temporaryModel({
    modelRef: 'mock/vision-model-3',
  });
  assert.equal(selection.modelRef, 'mock/vision-model-3');
  assert.equal(selection.label, 'Vision model 3');
  assert.equal(selection.supportsImages, true);
  assert.equal(selection.thinkingLevel, 'default');
  assert.deepEqual(selection.thinkingLevels, ['default', 'low', 'high']);
});

test('stop, close, and shutdown tear down streams and the private runtime in order', async () => {
  await temporaryChat.stopTemporary(303, 'stopped-chat');
  await temporaryChat.closeTemporary(303, 'missing-chat');

  const first = temporaryChat.temporaryPrompt(303, {
    id: 'first-chat',
    text: 'one',
    images: [],
    modelRef: 'mock/text-model-2',
    thinkingLevel: 'low',
  }, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  currentRuntime.pendingSubmits.shift().settlement.resolve({ status: 'completed' });
  await first;

  const second = temporaryChat.temporaryPrompt(303, {
    id: 'second-chat',
    text: 'two',
    images: [],
    modelRef: 'mock/text-model-2',
    thinkingLevel: 'low',
  }, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  currentRuntime.pendingSubmits.shift().settlement.resolve({ status: 'completed' });
  await second;

  await temporaryChat.stopTemporary(303, 'first-chat');
  const firstConversation = currentRuntime.conversations[0];
  assert.equal(firstConversation.aborted, true);
  assert.equal(currentRuntime.storage.closed, false);

  const releases = calls.length;
  await temporaryChat.closeTemporary(303, 'first-chat');
  assert.deepEqual(calls.slice(releases).filter(call => call[0] === 'provider'), [['provider', 'release', `provider-${firstConversation.id}`]]);
  assert.equal(currentRuntime.streams.find((entry) => entry.id === firstConversation.id).stopped, true);
  assert.equal(currentRuntime.storage.closed, false);

  await temporaryChat.closeTemporary(303, 'second-chat');
  await temporaryChat.shutdownTemporaryChats();
  assert.equal(currentRuntime.storage.closed, true);
  assert.ok(
    calls.findIndex((entry) => entry[0] === 'harness' && entry[1] === 'close')
      < calls.findIndex((entry) => entry[0] === 'storage' && entry[1] === 'close'),
  );

  currentRuntime = createMockRuntime();
  const shutdownPrompt = temporaryChat.temporaryPrompt(404, {
    id: 'shutdown-chat',
    text: 'finish',
    images: [],
    modelRef: 'mock/text-model-2',
    thinkingLevel: 'low',
  }, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  const pending = currentRuntime.pendingSubmits.shift();
  const shutdown = temporaryChat.shutdownTemporaryChats();
  await new Promise((resolve) => setImmediate(resolve));
  pending.settlement.resolve({ status: 'completed' });
  await Promise.allSettled([shutdownPrompt, shutdown]);
  assert.equal(currentRuntime.storage.closed, true);
  assert.equal(currentRuntime.conversations[0].aborted, true);
  assert.equal(currentRuntime.streams[0].stopped, true);
});

test('stopping an unanswered temporary prompt is a normal cancellation', async () => {
  currentRuntime = createMockRuntime();
  const events = [];
  const prompt = temporaryChat.temporaryPrompt(505, {
    id: 'stop-pending',
    text: 'keep generating',
    images: [],
    modelRef: 'mock/text-model-2',
    thinkingLevel: 'low',
  }, (event) => events.push(event));
  await new Promise((resolve) => setImmediate(resolve));

  const pending = currentRuntime.pendingSubmits.shift();
  await temporaryChat.stopTemporary(505, 'stop-pending');
  assert.equal(pending.conversation.aborted, true);

  pending.settlement.resolve({ status: 'unanswered', reason: 'aborted' });
  await assert.doesNotReject(prompt);
  assert.deepEqual(events.at(-1), { type: 'done' });

  await temporaryChat.closeTemporary(505, 'stop-pending');
  await temporaryChat.shutdownTemporaryChats();
  assert.equal(currentRuntime.storage.closed, true);
});

test('temporary chat installs safe user plugin tools into the private runtime registry and exposes them to the conversation', async () => {
  currentRuntime = createMockRuntime();
  safeExtensionEntries = [
    {
      extension: {
        name: 'studio.task-board',
        tools: [{ name: 'task_board_summary', replay: 'safe' }],
      },
      toolNames: ['task_board_list', 'task_board_get', 'task_board_summary'],
    },
  ];
  try {
    const prompt = temporaryChat.temporaryPrompt(606, {
      id: 'task-summary-chat',
      text: '整理今日日报',
      images: [],
      modelRef: 'mock/text-model-2',
      thinkingLevel: 'low',
    }, () => {});
    await new Promise((resolve) => setImmediate(resolve));

    const pending = currentRuntime.pendingSubmits.shift();
    assert.deepEqual(pending.conversation.options.agent.extensions.map((ext) => ext.name), ['studio.task-board']);
    assert.deepEqual(
      pending.conversation.options.agent.tools.map((tool) => tool.name),
      ['task_board_list', 'task_board_get', 'task_board_summary'],
    );
    assert.ok(pending.conversation.options.agent.instructions.includes('read-only user plugin tools are available'));
    assert.ok(calls.some((entry) => entry[0] === 'registry' && entry[1] === 'install' && entry[2] === 'studio.task-board'));

    pending.settlement.resolve({ status: 'completed' });
    await prompt;
    await temporaryChat.closeTemporary(606, 'task-summary-chat');
  } finally {
    safeExtensionEntries = [];
  }
});

test('a rejected first submission can retry without leaving empty history or a stale title', async () => {
  await temporaryChat.shutdownTemporaryChats();
  currentRuntime = createMockRuntime();
  const input = { id: 'retry-chat', text: 'rejected', images: [], modelRef: 'mock/text-model', thinkingLevel: 'low' };
  rejectNextSubmission = true;
  await assert.rejects(temporaryChat.temporaryPrompt(707, input, () => {}), /admission failed/);
  assert.equal(await temporaryChat.temporaryRead(input.id), null);
  const next = temporaryChat.temporaryPrompt(707, { ...input, text: 'accepted' }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  currentRuntime.pendingSubmits.shift().settlement.resolve({ status: 'completed' });
  await next;
  assert.equal(temporaryChat.temporaryHistory().find(chat => chat.id === input.id).title, 'accepted');
});

test('stopping during preparation leaves the draft unsent and out of temporary history', async () => {
  const id = 'cancel-before-admission';
  const pending = temporaryChat.temporaryPrompt(808, { id, text: 'draft', images: [] }, () => {});
  await temporaryChat.stopTemporary(808, id);
  await assert.rejects(pending, /发送已取消/);
  assert.equal(await temporaryChat.temporaryRead(id), null);
});
