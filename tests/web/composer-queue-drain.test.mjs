import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

import {
  markRejectedQueuedSubmission,
  removeAdmittedQueuedSubmission,
} from '../../web/src/features/conversation/composer-delivery.mjs';

// Exercise the actual App batch and automatic queue senders. The imported
// delivery helpers are injected because the extracted function text cannot
// carry App.tsx's ES module imports into this VM harness.
const source = fs.readFileSync(new URL('../../web/src/features/conversation/useMessageDelivery.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('useMessageDelivery.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(tree);
    else ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}
const functions = [
  declaration('markQueueAdmissionPending'),
  declaration('clearQueueAdmissionPending'),
  declaration('isQueueAdmissionPending'),
  declaration('sendQueuedNow'),
  declaration('sendAllQueued'),
  declaration('drainQueuedSession'),
  declaration('editQueued'),
  declaration('deleteQueued'),
  declaration('reorderQueued'),
];
assert(functions.every(Boolean));
const code = ts.transpileModule(
  `${functions.join('\n')}
globalThis.invokeSendNow = sendQueuedNow;
globalThis.invokeSendAll = sendAllQueued;
globalThis.invokeDrain = drainQueuedSession;
globalThis.invokeEdit = editQueued;
globalThis.invokeDelete = deleteQueued;
globalThis.invokeReorder = reorderQueued;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function queuedItem(id, requestId = `request-${id}`, text = `message-${id}`) {
  return {
    id: String(id),
    order: Number(id),
    text,
    attachments: [],
    submission: {
      sessionId: 'A',
      requestId,
      displayText: text,
      outgoingText: text,
      content: [{ type: 'text', text }],
      persistentAttachments: [],
      imagePayload: [],
      mentions: [],
      attachmentPaths: [],
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function harness({ dispatch, initialItems = [1, 2, 3], active = true } = {}) {
  const items = initialItems.map(id => (
    typeof id === 'number' ? queuedItem(id) : id
  ));
  const queuedPromptsRef = { current: { A: [...items] } };
  const sessionRef = { current: { id: 'A' } };
  const sendBlockedRef = { current: false };
  const turnActiveRef = { current: active };
  const queuedDrainSessionsRef = { current: new Set() };
  const queueAdmissionPendingRef = { current: {} };
  let queueAdmissionPendingBySession = {};
  const delivered = [];
  const modes = [];
  const notifications = [];
  const feedback = [];
  const context = {
    queuedPrompts: items,
    queuedPromptsRef,
    sessionRef,
    sendBlockedRef,
    turnActiveRef,
    queuedDrainSessionsRef,
    queueAdmissionPendingRef,
    setQueueAdmissionPendingBySession(update) {
      queueAdmissionPendingBySession = typeof update === 'function'
        ? update(queueAdmissionPendingBySession)
        : update;
    },
    markRejectedQueuedSubmission,
    removeAdmittedQueuedSubmission,
    queuedEditContextsRef: { current: {} },
    prompt: '',
    composerAttachments: [],
    composerDraftKeyRef: { current: 'session:A' },
    saveComposerDraft() {},
    setPrompt() {},
    setComposerAttachments() {},
    requestAnimationFrame() {},
    showComposerFeedback(...args) {
      feedback.push(args);
    },
    updateSessionQueuedPrompts(id, update) {
      queuedPromptsRef.current[id] = update(queuedPromptsRef.current[id] ?? []);
    },
    pushNotification(...args) {
      notifications.push(args);
    },
    errorText(error) {
      return error instanceof Error ? error.message : String(error);
    },
    async dispatchSubmission(submission, mode) {
      delivered.push(submission.requestId);
      modes.push(mode);
      if (dispatch) return dispatch(submission, mode, delivered.length);
      return { state: 'admitted', current: true };
    },
    async submitQueuedInBackground(submission) {
      delivered.push(submission.requestId);
      modes.push(undefined);
      if (dispatch) return dispatch(submission, undefined, delivered.length);
      return { state: 'admitted', current: false };
    },
  };
  vm.runInNewContext(code, context);
  return {
    ...context,
    delivered,
    modes,
    notifications,
    feedback,
    sendNow: context.invokeSendNow,
    sendAll: context.invokeSendAll,
    drain: context.invokeDrain,
    edit: context.invokeEdit,
    remove: context.invokeDelete,
    reorder: context.invokeReorder,
    pendingState: () => ({ ...queueAdmissionPendingBySession }),
  };
}

test('single send retains a rejected item at its original position and ignores duplicate clicks', async () => {
  const first = deferred();
  const h = harness({ dispatch: async () => first.promise });
  const pending = h.sendNow('2');
  await h.sendNow('2');
  assert.deepEqual(h.delivered, ['request-2']);
  assert.deepEqual(h.queuedPromptsRef.current.A.map(item => item.id), ['1', '2', '3']);

  first.resolve({ state: 'rejected', current: true, error: 'steer rejected' });
  await pending;
  assert.deepEqual(h.queuedPromptsRef.current.A.map(item => item.id), ['1', '2', '3']);
  assert.equal(h.queuedPromptsRef.current.A[1].autoRetryError, 'steer rejected');
});

test('an admission-pending row stays stable and cannot be edited, removed or reordered', async () => {
  const request = deferred();
  const h = harness({ dispatch: async () => request.promise });
  const pending = h.sendNow('2');

  assert.deepEqual(h.pendingState(), { A: 'request-2' });
  assert.deepEqual(h.queuedPromptsRef.current.A.map(item => item.id), ['1', '2', '3']);

  h.edit('2');
  h.remove('2');
  h.reorder('2', '1');
  assert.deepEqual(h.queuedPromptsRef.current.A.map(item => item.id), ['1', '2', '3']);
  assert.deepEqual(h.feedback, []);

  request.resolve({ state: 'rejected', current: true, error: 'retry later' });
  await pending;
  assert.deepEqual(h.pendingState(), {});
  assert.deepEqual(h.queuedPromptsRef.current.A.map(item => item.id), ['1', '2', '3']);
  assert.equal(h.queuedPromptsRef.current.A[1].autoRetryError, 'retry later');
});

test('single send removes only after admission and cannot delete a newer queued edit', async () => {
  const first = deferred();
  const h = harness({
    initialItems: [1, 2],
    dispatch: async () => first.promise,
  });
  const pending = h.sendNow('2');
  const edited = queuedItem(2, 'request-edited-2', 'edited second');
  h.queuedPromptsRef.current.A = [h.queuedPromptsRef.current.A[0], edited];
  first.resolve({ state: 'admitted-but-postcommit-read-failed', current: true, error: 'read stale' });
  await pending;
  assert.deepEqual(h.queuedPromptsRef.current.A.map(item => item.submission.requestId), [
    'request-1',
    'request-edited-2',
  ]);
});

test('batch send keeps every item until its exact request is admitted', async () => {
  const first = deferred();
  const h = harness({
    dispatch: async (_submission, count) => (
      count === 1
        ? first.promise
        : { state: 'admitted', current: true }
    ),
  });
  const pending = h.sendAll();
  assert.deepEqual(h.delivered, ['request-1']);
  assert.deepEqual(h.queuedPromptsRef.current.A.map(item => item.id), ['1', '2', '3']);

  first.resolve({ state: 'admitted-but-postcommit-read-failed', current: true, error: 'refresh failed' });
  await pending;
  assert.deepEqual(h.delivered, ['request-1', 'request-2', 'request-3']);
  assert.deepEqual(h.queuedPromptsRef.current.A, []);
});

test('batch rejection keeps the item at its position and stops later sends', async () => {
  const h = harness({
    dispatch: async () => ({ state: 'rejected', current: true, error: 'busy lock changed' }),
  });
  await h.sendAll();
  assert.deepEqual(h.delivered, ['request-1']);
  assert.deepEqual(h.queuedPromptsRef.current.A.map(item => item.id), ['1', '2', '3']);
  assert.equal(h.queuedPromptsRef.current.A[0].autoRetryError, 'busy lock changed');
  assert.equal(h.queuedDrainSessionsRef.current.has('A'), false);
});

test('an idle user retry sends the rejected item normally and clears it only after admission', async () => {
  const failed = { ...queuedItem(1), autoRetryError: 'automatic drain was rejected' };
  const h = harness({ initialItems: [failed], active: false });
  await h.sendNow('1');
  assert.deepEqual(h.delivered, ['request-1']);
  assert.deepEqual(h.modes, ['prompt']);
  assert.deepEqual(h.queuedPromptsRef.current.A, []);
});

test('batch send starts a normal prompt while idle and steers only later items', async () => {
  const h = harness({ active: false });
  await h.sendAll();
  assert.deepEqual(h.delivered, ['request-1', 'request-2', 'request-3']);
  assert.deepEqual(h.modes, ['prompt', 'steer', 'steer']);
  assert.deepEqual(h.queuedPromptsRef.current.A, []);
});

test('a row edited during admission is not deleted or replaced by its old request', async () => {
  const first = deferred();
  const h = harness({
    initialItems: [1, 2],
    dispatch: async () => first.promise,
  });
  const pending = h.sendAll();
  const edited = queuedItem(1, 'request-edited', 'edited message');
  h.queuedPromptsRef.current.A = [edited, h.queuedPromptsRef.current.A[1]];

  first.resolve({ state: 'admitted', current: true });
  await pending;
  assert.deepEqual(h.delivered, ['request-1']);
  assert.deepEqual(h.queuedPromptsRef.current.A.map(item => item.submission.requestId), [
    'request-edited',
    'request-2',
  ]);
  assert.equal(h.queuedPromptsRef.current.A[0].text, 'edited message');
});

test('batch send follows a reorder made while the previous request is in flight', async () => {
  const first = deferred();
  const h = harness({
    dispatch: async (_submission, count) => (
      count === 1
        ? first.promise
        : { state: 'admitted', current: true }
    ),
  });
  const pending = h.sendAll();
  h.queuedPromptsRef.current.A = [
    h.queuedPromptsRef.current.A[2],
    h.queuedPromptsRef.current.A[0],
    h.queuedPromptsRef.current.A[1],
  ];
  first.resolve({ state: 'admitted', current: true });
  await pending;
  assert.deepEqual(h.delivered, ['request-1', 'request-3', 'request-2']);
  assert.deepEqual(h.queuedPromptsRef.current.A, []);
});

test('duplicate batch clicks share one synchronous drain lock', async () => {
  const first = deferred();
  const h = harness({ dispatch: async () => first.promise });
  const pending = h.sendAll();
  await h.sendAll();
  assert.deepEqual(h.delivered, ['request-1']);
  first.resolve({ state: 'rejected', current: true, error: 'stop' });
  await pending;
});

test('automatic drain retains a rejected head and will not retry it on another effect pass', async () => {
  const item = queuedItem(1);
  const h = harness({
    initialItems: [item, queuedItem(2)],
    dispatch: async () => ({ state: 'rejected', current: false, error: 'background busy' }),
  });
  await h.drain('A', item, false);
  assert.deepEqual(h.delivered, ['request-1']);
  assert.equal(h.queuedPromptsRef.current.A[0].autoRetryError, 'background busy');
  assert.deepEqual(h.queuedPromptsRef.current.A.map(candidate => candidate.id), ['1', '2']);

  await h.drain('A', h.queuedPromptsRef.current.A[0], false);
  assert.deepEqual(h.delivered, ['request-1']);
});

test('automatic drain removes only after admission and preserves an in-flight edit', async () => {
  const first = deferred();
  const item = queuedItem(1);
  const h = harness({
    initialItems: [item],
    dispatch: async () => first.promise,
  });
  const pending = h.drain('A', item, false);
  const edited = queuedItem(1, 'request-edited', 'edited while waiting');
  h.queuedPromptsRef.current.A = [edited];
  assert.deepEqual(h.queuedPromptsRef.current.A.map(candidate => candidate.text), [
    'edited while waiting',
  ]);
  first.resolve({ state: 'admitted-but-postcommit-read-failed', current: false, error: 'projection stale' });
  await pending;
  assert.deepEqual(h.queuedPromptsRef.current.A.map(candidate => candidate.submission.requestId), [
    'request-edited',
  ]);
});

test('batch interruption by compaction or session switch keeps the remaining queue intact', async () => {
  for (const reason of ['compaction', 'session']) {
    const first = deferred();
    const h = harness({ dispatch: async () => first.promise });
    const pending = h.sendAll();
    if (reason === 'compaction') h.sendBlockedRef.current = true;
    else h.sessionRef.current = { id: 'B' };
    first.resolve({ state: 'admitted', current: true });
    await pending;
    assert.deepEqual(h.delivered, ['request-1']);
    assert.deepEqual(h.queuedPromptsRef.current.A.map(item => item.id), ['2', '3']);
    assert.equal(h.queuedDrainSessionsRef.current.has('A'), false);
  }
});
