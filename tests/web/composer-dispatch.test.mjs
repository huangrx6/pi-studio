import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { loadTranscriptWindow } from '../../web/src/features/conversation/transcript-load.mjs';

const source = fs.readFileSync(new URL('../../web/src/features/conversation/useMessageDelivery.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('useMessageDelivery.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration;
let backgroundDeclaration;
let sendDeclaration;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'dispatchSubmission') {
    declaration = node.getText(tree);
  } else if (ts.isFunctionDeclaration(node) && node.name?.text === 'submitQueuedInBackground') {
    backgroundDeclaration = node.getText(tree);
  } else if (ts.isFunctionDeclaration(node) && node.name?.text === 'send') {
    sendDeclaration = node.getText(tree);
  } else {
    ts.forEachChild(node, visit);
  }
}
visit(tree);
assert(declaration);
assert(backgroundDeclaration);
assert(sendDeclaration);
const dispatchCode = ts.transpileModule(
  `${declaration}\n${backgroundDeclaration}\n`
    + 'globalThis.invoke = dispatchSubmission; '
    + 'globalThis.invokeBackground = submitQueuedInBackground;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const sendCode = ts.transpileModule(
  `${sendDeclaration}\nglobalThis.invokeSend = send;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function submission() {
  return {
    sessionId: 'A',
    requestId: 'stable-request',
    displayText: 'hello',
    outgoingText: 'hello',
    content: [{ type: 'text', text: 'hello' }],
    persistentAttachments: [],
    imagePayload: [],
    mentions: [],
    attachmentPaths: [],
  };
}

function harness({ submit, page = async () => ({ messages: [] }) }) {
  let messages = [];
  let busy = false;
  let error = null;
  let compaction = { active: false };
  const calls = {
    submitted: [],
    notifications: [],
    outlines: [],
  };
  const context = {
    compaction,
    sessionLoadRef: { current: 1 },
    transcriptPageRef: { current: null },
    sessionRef: { current: { id: 'A' } },
    sendBlockedRef: { current: false },
    requestRef: { current: '' },
    latestPromptBySessionRef: { current: new Map() },
    outlineItems: [],
    resumeTranscriptFollow() {},
    setMessages(update) {
      messages = typeof update === 'function' ? update(messages) : update;
    },
    setBusy(value) {
      busy = typeof value === 'function' ? value(busy) : value;
    },
    setError(value) {
      error = typeof value === 'function' ? value(error) : value;
    },
    setRetryInfo() {},
    setLiveDiff() {},
    setCompaction(value) {
      compaction = typeof value === 'function' ? value(compaction) : value;
      context.compaction = compaction;
    },
    setSession() {},
    setRequestTraces() {},
    applyOutline() {},
    pushNotification(...args) {
      calls.notifications.push(args);
    },
    errorText(value) {
      return value instanceof Error ? value.message : String(value);
    },
    async loadState() {},
    // dispatchSubmission 里的 loadTranscriptWindow 是自由变量，从上下文取。
    loadTranscriptWindow: (loadPage, id) => loadTranscriptWindow(loadPage, id),
    async refreshOutline(id) {
      calls.outlines.push(id);
      return undefined;
    },
    window: {
      piApi: {
        async conversationSubmit(payload) {
          calls.submitted.push(payload);
          return submit(payload);
        },
        async conversationPage() {
          return page();
        },
      },
    },
  };
  vm.runInNewContext(dispatchCode, context);
  return {
    ...context,
    calls,
    invoke: context.invoke,
    invokeBackground: context.invokeBackground,
    getMessages: () => messages,
    getBusy: () => busy,
    getError: () => error,
    setCompactionActive(active) {
      context.compaction = { active };
      compaction = context.compaction;
    },
  };
}

function draft(text, attachments = []) {
  return { text, attachments };
}

function sendHarness({
  dispatch,
  initialDraft = draft('hello'),
  turnActive = false,
  initialRetries = [],
} = {}) {
  const store = new Map([['session:A', initialDraft]]);
  const retries = new Map(initialRetries);
  let prompt = initialDraft.text;
  let attachments = [...initialDraft.attachments];
  let queue = {};
  let generated = 0;
  const calls = {
    dispatched: [],
    feedback: [],
    notifications: [],
    preparedRequestIds: [],
    prompts: [],
  };
  const context = {
    sendBlockedRef: { current: false },
    composerDraftKeyRef: { current: 'session:A' },
    preparingDraftsRef: { current: new Set() },
    composerDraftsRef: { current: store },
    composerDeliveryRetriesRef: { current: retries },
    latestComposerAttemptByKeyRef: { current: new Map() },
    sessionLoadRef: { current: 1 },
    transcriptPageRef: { current: null },
    sessionRef: { current: { id: 'A', cwd: '/workspace-a' } },
    turnActiveRef: { current: turnActive },
    queuedEditContextsRef: { current: {} },
    latestPromptBySessionRef: { current: new Map() },
    modelPickerRequestRef: { current: 0 },
    session: { id: 'A', cwd: '/workspace-a' },
    workspace: '/workspace-a',
    modelSelection: { modelRef: 'model', supportsImages: true },
    prompt,
    composerAttachments: attachments,
    compacting: { active: false },
    crypto: {
      randomUUID() {
        generated += 1;
        return `generated-${generated}`;
      },
    },
    readComposerDraft(map, key) {
      const saved = map.get(key);
      return saved
        ? { text: saved.text, attachments: [...saved.attachments] }
        : { text: '', attachments: [] };
    },
    saveComposerDraft(map, key, next) {
      if (!next.text && next.attachments.length === 0) map.delete(key);
      else map.set(key, { text: next.text, attachments: [...next.attachments] });
    },
    snapshotComposerDraft(value) {
      return { text: value.text, attachments: value.attachments.map(item => ({ ...item })) };
    },
    composerDraftMatches(left, right) {
      return left.text === right.text
        && left.attachments.length === right.attachments.length
        && left.attachments.every((item, index) => item.id === right.attachments[index]?.id);
    },
    retainedComposerRequestId(saved, currentDraft) {
      return saved && context.composerDraftMatches(currentDraft, saved.draft)
        ? saved.requestId
        : undefined;
    },
    mergeRejectedComposerDraft(currentDraft, rejected) {
      const text = rejected.text && currentDraft.text
        ? `${rejected.text}\n\n${currentDraft.text}`
        : rejected.text || currentDraft.text;
      return { text, attachments: [...rejected.attachments, ...currentDraft.attachments] };
    },
    async prepareSubmission(text, items, sessionId, requestId) {
      calls.preparedRequestIds.push(requestId);
      return {
        sessionId,
        requestId: requestId || `prepared-${generated + 1}`,
        displayText: text,
        outgoingText: text,
        content: [{ type: 'text', text }],
        persistentAttachments: [],
        imagePayload: [],
        mentions: [],
        attachmentPaths: [],
      };
    },
    async dispatchSubmission(submission, mode) {
      calls.dispatched.push({ submission, mode });
      return dispatch(submission, mode, context);
    },
    updateSessionQueuedPrompts(sessionId, update) {
      queue = { ...queue, [sessionId]: update(queue[sessionId] ?? []) };
    },
    setPreparingDraftKeys() {},
    setComposerMenu() {},
    setTodoPanelOpen() {},
    setError() {},
    setModelPickerRequest() {},
    setSession() {},
    setMessages() {},
    setRequestTraces() {},
    setPrompt(value) {
      prompt = value;
      context.prompt = value;
      calls.prompts.push(value);
    },
    setComposerAttachments(value) {
      attachments = value;
      context.composerAttachments = value;
    },
    clearActiveComposerDraftText() {
      store.set(context.composerDraftKeyRef.current, { text: '', attachments: [] });
      context.prompt = '';
    },
    clearActiveComposerDraft() {
      store.delete(context.composerDraftKeyRef.current);
      prompt = '';
      attachments = [];
      context.prompt = '';
      context.composerAttachments = [];
    },
    showComposerFeedback(...args) {
      calls.feedback.push(args);
    },
    pushNotification(...args) {
      calls.notifications.push(args);
    },
    errorText(error) {
      return error instanceof Error ? error.message : String(error);
    },
    async findExtensionCommand() {
      return undefined;
    },
    async executeBuiltinCommand() {
      return false;
    },
    async executeExtensionCommand() {
      return false;
    },
    parseStudioCommand() {
      return undefined;
    },
    async loadState() {},
    window: {
      piApi: {
        async createConversation() {
          throw new Error('not used');
        },
      },
    },
  };
  vm.runInNewContext(sendCode, context);
  return {
    ...context,
    calls,
    queue: () => ({ ...queue }),
    retries,
    send: (text, busyBehavior = 'steer') => context.invokeSend(text, busyBehavior),
    store,
    visiblePrompt: () => context.prompt,
  };
}

test('only an explicit conversationSubmit rejection returns the retryable state and removes the optimistic message', async () => {
  const h = harness({ submit: async () => { throw new Error('busy rejected'); } });
  const outcome = await h.invoke(submission(), 'prompt');
  assert.deepEqual(structuredClone(outcome), {
    state: 'rejected',
    current: true,
    error: 'busy rejected',
  });
  assert.deepEqual([...h.getMessages()], []);
  assert.equal(h.getBusy(), false);
  assert.equal(h.getError(), 'busy rejected');
  assert.equal(h.calls.submitted[0].requestId, 'stable-request');
});

test('a compaction or stop lock observed at dispatch time rejects before any IPC call', async () => {
  const h = harness({ submit: async () => ({ admitted: true }) });
  h.sendBlockedRef.current = true;
  h.setCompactionActive(true);
  const outcome = await h.invoke(submission(), 'prompt');
  assert.equal(outcome.state, 'rejected');
  assert.equal(outcome.error, '上下文压缩期间暂时不能发送。');
  assert.equal(h.calls.submitted.length, 0);
  assert.deepEqual([...h.getMessages()], []);
});

test('a backend post-commit warning remains admitted and never removes the optimistic message', async () => {
  const h = harness({
    submit: async () => ({
      admitted: true,
      postCommitError: '消息已提交，但会话状态暂时无法读取。',
    }),
    page: async () => { throw new Error('history unavailable'); },
  });
  const outcome = await h.invoke(submission(), 'prompt');
  assert.equal(outcome.state, 'admitted-but-postcommit-read-failed');
  assert.equal(outcome.current, true);
  assert.match(outcome.error, /状态暂时无法读取|对话记录暂时无法刷新/);
  assert.equal(h.getMessages().length, 1);
  assert.equal(h.getMessages()[0].optimisticRequestId, 'stable-request');
  assert.equal(h.calls.notifications.at(-1)[2], '消息已提交');
});

test('a renderer transcript read failure after admission is a committed warning', async () => {
  const h = harness({
    submit: async () => ({ admitted: true }),
    page: async () => { throw new Error('history unavailable'); },
  });
  const outcome = await h.invoke(submission(), 'prompt');
  assert.deepEqual(structuredClone(outcome), {
    state: 'admitted-but-postcommit-read-failed',
    current: true,
    error: '消息已提交，但对话记录暂时无法刷新。',
  });
  assert.equal(h.getMessages().length, 1);
  assert.equal(h.getBusy(), true);
  assert.equal(h.getError(), null);
});

test('a submission that finishes after navigation is admitted but does not read or replay into the new conversation', async () => {
  let resolve;
  const h = harness({
    submit: payload => new Promise((next) => {
      resolve = () => next({ admitted: true, requestId: payload.requestId });
    }),
  });
  const pending = h.invoke(submission(), 'prompt');
  h.sessionRef.current = { id: 'B' };
  resolve();
  const outcome = await pending;
  assert.deepEqual(structuredClone(outcome), { state: 'admitted', current: false });
  assert.deepEqual(h.calls.outlines, []);
});

test('a post-commit warning stays visible after the user switches conversations', async () => {
  let resolve;
  const h = harness({
    submit: () => new Promise((next) => {
      resolve = () => next({
        admitted: true,
        postCommitError: '消息已提交，但项目记录暂时无法刷新。',
      });
    }),
  });
  const pending = h.invoke(submission(), 'prompt');
  h.sessionRef.current = { id: 'B' };
  h.sessionLoadRef.current += 1;
  resolve();
  const outcome = await pending;
  assert.equal(outcome.state, 'admitted-but-postcommit-read-failed');
  assert.equal(outcome.current, false);
  assert.equal(h.calls.notifications.at(-1)[2], '消息已提交');
  assert.equal(h.calls.notifications.at(-1)[3], 'A');
  assert.deepEqual(h.calls.outlines, []);
});

test('returning to the same conversation lets its admitted result refresh the current transcript', async () => {
  let resolve;
  const h = harness({
    submit: payload => new Promise((next) => {
      resolve = () => next({ admitted: true, requestId: payload.requestId });
    }),
    page: async () => ({
      id: 'A',
      cwd: '/workspace-a',
      title: 'Session A',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'persisted reply' }] }],
      requestTraces: [],
      messageStart: 0,
    }),
  });
  const pending = h.invoke(submission(), 'prompt');
  h.sessionRef.current = { id: 'B' };
  h.sessionLoadRef.current += 1;
  h.sessionRef.current = { id: 'A' };
  h.sessionLoadRef.current += 1;
  resolve();
  const outcome = await pending;
  assert.deepEqual(structuredClone(outcome), { state: 'admitted', current: true });
  assert.deepEqual(h.calls.outlines, ['A']);
  assert.deepEqual(structuredClone([...h.getMessages()]), [
    { role: 'user', content: [{ type: 'text', text: 'persisted reply' }] },
  ]);
});

test('an A to B to A rejection is applied to A while remaining isolated from B', async () => {
  let reject;
  const h = harness({
    submit: () => new Promise((_next, fail) => {
      reject = () => fail(new Error('rejected after returning'));
    }),
  });
  const pending = h.invoke(submission(), 'prompt');
  h.sessionRef.current = { id: 'B' };
  h.sessionLoadRef.current += 1;
  h.sessionRef.current = { id: 'A' };
  h.sessionLoadRef.current += 1;
  reject();
  const outcome = await pending;
  assert.equal(outcome.state, 'rejected');
  assert.equal(outcome.current, true);
  assert.deepEqual([...h.getMessages()], []);
  assert.equal(h.getError(), 'rejected after returning');
});

test('queued retries clear the exact session draft key and never reuse an admitted request id', async () => {
  const original = draft('queue once');
  const h = sendHarness({
    turnActive: true,
    initialDraft: original,
    initialRetries: [
      ['session:A', { draft: original, requestId: 'rejected-request' }],
      ['A', { draft: draft('unrelated'), requestId: 'untouched-request' }],
    ],
    dispatch: async () => ({ state: 'admitted', current: true }),
  });

  await h.send(undefined, 'queue');
  assert.deepEqual(h.calls.preparedRequestIds, ['rejected-request']);
  assert.equal(h.retries.has('session:A'), false);
  assert.equal(h.retries.get('A').requestId, 'untouched-request');
  assert.deepEqual(structuredClone(h.queue().A.map(item => item.submission.requestId)), [
    'rejected-request',
  ]);

  h.saveComposerDraft(h.composerDraftsRef.current, 'session:A', original);
  await h.send(undefined, 'queue');
  assert.deepEqual(h.calls.preparedRequestIds, ['rejected-request', undefined]);
  const queuedRequestIds = structuredClone(
    h.queue().A.map(item => item.submission.requestId),
  );
  assert.equal(queuedRequestIds[0], 'rejected-request');
  assert.notEqual(queuedRequestIds[1], 'rejected-request');
  assert.notEqual(queuedRequestIds[1], undefined);
});

test('a direct rejection while viewing another conversation restores only its own draft and notifies', async () => {
  const original = draft('recover only A');
  const pending = deferred();
  const started = deferred();
  const h = sendHarness({
    initialDraft: original,
    dispatch: async () => {
      started.resolve();
      return pending.promise;
    },
  });
  const delivery = h.send();
  await started.promise;

  h.sessionRef.current = { id: 'B', cwd: '/workspace-b' };
  h.composerDraftKeyRef.current = 'session:B';
  h.saveComposerDraft(h.composerDraftsRef.current, 'session:B', draft('keep B draft'));
  pending.resolve({ state: 'rejected', current: false, error: 'session is busy' });
  await delivery;

  assert.equal(h.store.get('session:A').text, 'recover only A');
  assert.equal(h.store.get('session:B').text, 'keep B draft');
  assert.equal(h.calls.notifications.at(-1)[2], '消息未发送');
  assert.equal(h.calls.notifications.at(-1)[3], 'A');
  assert.match(h.calls.notifications.at(-1)[0], /session is busy/);
});

test('A to B to A applies a pre-admission rejection to the current A composer', async () => {
  const original = draft('return to A');
  const h = sendHarness({
    initialDraft: original,
    dispatch: async () => {
      h.sessionRef.current = { id: 'B', cwd: '/workspace-b' };
      h.composerDraftKeyRef.current = 'session:B';
      h.sessionLoadRef.current += 1;
      h.sessionRef.current = { id: 'A', cwd: '/workspace-a' };
      h.composerDraftKeyRef.current = 'session:A';
      h.sessionLoadRef.current += 1;
      return { state: 'rejected', current: true, error: 'retry now' };
    },
  });

  await h.send();
  assert.equal(h.store.get('session:A').text, 'return to A');
  assert.equal(h.visiblePrompt(), 'return to A');
  assert.equal(h.calls.notifications.length, 0);
});

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test('background queue rejection remains retryable and is surfaced as a notification', async () => {
  const h = harness({
    submit: async () => { throw new Error('background rejected'); },
  });
  const outcome = await h.invokeBackground(submission());
  assert.deepEqual(structuredClone(outcome), {
    state: 'rejected',
    current: false,
    error: 'background rejected',
  });
  assert.equal(h.calls.notifications.at(-1)[2], '排队发送失败');
  assert.match(h.calls.notifications.at(-1)[0], /background rejected/);
});

test('background queue projection failure is admitted and reported without replaying the request', async () => {
  const h = harness({
    submit: async () => ({
      admitted: true,
      postCommitError: '消息已提交，但会话状态暂时无法读取。',
    }),
  });
  const outcome = await h.invokeBackground(submission());
  assert.equal(outcome.state, 'admitted-but-postcommit-read-failed');
  assert.equal(outcome.current, false);
  assert.equal(h.calls.submitted.length, 1);
  assert.equal(h.calls.notifications.at(-1)[2], '排队消息已发送');
});
