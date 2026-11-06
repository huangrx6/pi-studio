const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { after, test } = require('node:test');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');

installElectronSafeStorage({ after });
const { createStudioDatabase } = require('../../electron/core/studio-db.cjs');

const originalLoad = Module._load;
let studioDatabase;
let behavior;
let durableConversation;
let conversationModule;

function databaseFacade() {
  return {
    getConversation: (...args) => studioDatabase.getConversation(...args),
    updateConversation: (...args) => {
      if (behavior.failProjection) throw new Error('synthetic projection failure');
      return studioDatabase.updateConversation(...args);
    },
  };
}

function createDurableFixture() {
  const submissions = new Map();
  let submissionCalls = 0;
  let configurationCalls = 0;

  durableConversation = {
    id: '1',
    async entries() {
      if (behavior.failTitleRead) throw new Error('synthetic title read failure');
      return { items: [], next: undefined };
    },
    async configure() {
      configurationCalls += 1;
    },
    async commit(run) {
      await run({ doc: async () => ({}) });
    },
    async submit(payload) {
      submissionCalls += 1;
      let submission = submissions.get(payload.requestId);
      if (!submission) {
        submission = {
          id: `submission-${submissions.size + 1}`,
          payload,
          async status() {
            if (behavior.failStatus) throw new Error('synthetic status failure');
            return { status: behavior.status || 'queued' };
          },
        };
        submissions.set(payload.requestId, submission);
      }
      if (behavior.rejectSubmit) throw new Error('synthetic pre-admission rejection');
      return submission;
    },
  };

  return {
    runtime: {
      context: { name: 'synthetic-context' },
      harness: {
        conversation: () => durableConversation,
      },
      durable: {},
    },
    get submissionCalls() {
      return submissionCalls;
    },
    get configurationCalls() {
      return configurationCalls;
    },
    get uniqueSubmissions() {
      return submissions.size;
    },
  };
}

Module._load = function loadConversationFixture(request, parent, isMain) {
  if (request.endsWith('core/studio-db.cjs')) {
    return { getStudioDatabase: databaseFacade };
  }
  if (request === './durable-runtime.cjs') {
    return {
      getDurableRuntime: async () => behavior.runtime,
      latestEntry: () => undefined,
      reconcileRuntimeForWorkspace: async () => {},
    };
  }
  if (request === '../services/sensitive-input-guard.cjs') {
    return { guardSensitiveInput: async () => ({ accepted: true }) };
  }
  if (request === './tool-selection.cjs') {
    return { runtimeSelection: async () => ({ extensions: [], tools: [] }) };
  }
  if (request === '../services/workspace.cjs') {
    return { fileReferenceContext: async () => [] };
  }
  if (request === '../services/attachments.cjs') {
    return {
      attachmentContext: async () => [],
      removeAttachmentDirectory: async () => {},
    };
  }
  if (request === '../capabilities/skills/index.cjs') {
    return {
      composerSkills: () => [],
      expandSkillCommand: text => text,
    };
  }
  if (request === '../capabilities/long-task/index.cjs') {
    return {
      clearLongTaskState: target => target,
      completeLongTaskState: target => target,
      continuationText: () => '',
      createLongTaskContract: () => ({ LongTask: 'synthetic-long-task' }),
      editLongTaskState: target => target,
      emptyLongTaskState: () => ({
        enabled: false,
        goal: '',
        status: 'idle',
      }),
      initializeLongTaskState: target => target,
      isLongTaskContinuation: () => false,
      nextLongTaskContinuationGuard: () => undefined,
      normalizeLongTaskState: value => value,
      publicLongTaskState: value => value || {},
      readLongTaskState: async () => ({ enabled: false }),
      replaceLongTaskState: target => target,
      shouldStartLongTaskGoal: () => false,
      validateLongTaskGoal: value => value,
    };
  }
  if (request === '../capabilities/request-trace/index.cjs') {
    return { onRequestTrace: () => () => {} };
  }
  if (request === '../capabilities/subagents/index.cjs') {
    return { discardManagedWorktreesForConversations: async () => {} };
  }
  if (request === '../services/turn-diff.cjs') {
    return { beginTurn: () => {}, endTurn: () => {}, saveTurnDiff: () => {} };
  }
  if (request === '../services/studio-extensions.cjs') {
    return {
      extensionComposerCommands: () => [],
      purgeProjectWorkspaceState: () => {},
    };
  }
  if (request === '../services/conversation-title.cjs') {
    return {
      generateConversationTitleAfterIdle: async () => '',
      temporaryTitle: value => value || '新会话',
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
conversationModule = require('../../electron/runtime/conversations.cjs');
Module._load = originalLoad;

function createFixture(t, { title = 'Ready conversation' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-admission-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  studioDatabase = createStudioDatabase(path.join(directory, 'studio.sqlite'));
  studioDatabase.insertConversation({
    id: '1',
    publicId: 'conversation-public',
    workspace,
    kind: 'conversation',
    title,
    titleSource: 'auto',
  });
  const durable = createDurableFixture();
  behavior = {
    runtime: durable.runtime,
    status: 'queued',
    failStatus: false,
    failProjection: false,
    failTitleRead: false,
    rejectSubmit: false,
  };
  t.after(() => {
    studioDatabase.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return durable;
}

test('pre-admission rejection throws and never invokes admitted presentation callbacks', async (t) => {
  const durable = createFixture(t);
  behavior.rejectSubmit = true;
  let admitted = 0;
  await assert.rejects(
    conversationModule.submitConversation({
      id: 'conversation-public',
      text: 'retry me',
      requestId: 'request-rejected',
    }, {
      onAdmitted: () => { admitted += 1; },
    }),
    /pre-admission rejection/,
  );
  assert.equal(admitted, 0);
  assert.equal(durable.submissionCalls, 1);
  assert.equal(studioDatabase.getConversation('1').lastRequestId, '');
});

test('status read failure after Durable admission returns unknown, not a retryable rejection', async (t) => {
  const durable = createFixture(t);
  behavior.failStatus = true;
  let admitted = 0;
  const result = await conversationModule.submitConversation({
    id: 'conversation-public',
    text: 'already committed',
    requestId: 'request-status-failure',
  }, {
    onAdmitted: () => { admitted += 1; },
  });

  assert.equal(admitted, 1);
  assert.equal(result.admitted, true);
  assert.equal(result.status, 'unknown');
  assert.match(result.postCommitError, /状态暂时无法读取/);
  assert.equal(result.requestId, 'request-status-failure');
  assert.equal(durable.submissionCalls, 1);
  assert.equal(studioDatabase.getConversation('1').lastRequestId, 'request-status-failure');
});

test('Studio projection failure after admission returns the committed DTO with a safe warning', async (t) => {
  const durable = createFixture(t);
  behavior.status = 'placed';
  behavior.failProjection = true;
  const result = await conversationModule.submitConversation({
    id: 'conversation-public',
    text: 'projection will fail',
    requestId: 'request-projection-failure',
  });

  assert.equal(result.admitted, true);
  assert.equal(result.status, 'placed');
  assert.match(result.postCommitError, /会话摘要暂时无法更新/);
  assert.doesNotMatch(JSON.stringify(result), /synthetic projection failure|sqlite|stack/i);
  assert.equal(durable.submissionCalls, 1);
  assert.equal(studioDatabase.getConversation('1').lastRequestId, '');
});

test('a throwing admitted callback cannot turn a committed Durable input into a retryable error', async (t) => {
  const durable = createFixture(t);
  const result = await conversationModule.submitConversation({
    id: 'conversation-public',
    text: 'committed despite presentation callback',
    requestId: 'request-callback-failure',
  }, {
    onAdmitted: () => { throw new Error('notification subsystem unavailable'); },
  });

  assert.equal(result.admitted, true);
  assert.equal(result.status, 'queued');
  assert.equal(result.postCommitError, undefined);
  assert.equal(durable.submissionCalls, 1);
});

test('a background title read failure cannot delay or reject an admitted submission', async (t) => {
  const durable = createFixture(t, { title: '新会话' });
  behavior.failTitleRead = true;
  const result = await conversationModule.submitConversation({
    id: 'conversation-public',
    text: 'first question whose title cannot be read yet',
    requestId: 'request-title-failure',
  });

  assert.equal(result.admitted, true);
  assert.equal(result.status, 'queued');
  assert.equal(result.postCommitError, undefined);
  assert.equal(durable.submissionCalls, 1);
  await new Promise(resolve => setImmediate(resolve));
});

test('the renderer request id is forwarded unchanged and Durable deduplicates retries', async (t) => {
  const durable = createFixture(t);
  const input = {
    id: 'conversation-public',
    text: 'send once',
    requestId: 'stable-request-id',
  };
  const first = await conversationModule.submitConversation(input);
  const retry = await conversationModule.submitConversation(input);

  assert.equal(first.requestId, 'stable-request-id');
  assert.equal(retry.requestId, 'stable-request-id');
  assert.equal(first.submissionId, retry.submissionId);
  assert.equal(durable.submissionCalls, 2);
  assert.equal(durable.uniqueSubmissions, 1);
  assert.equal(
    durableConversation && studioDatabase.getConversation('1').lastRequestId,
    'stable-request-id',
  );
});
