'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  trackConversationStream,
} = require('../../electron/runtime/conversation-stream-lifecycle.cjs');

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

test('unexpected watch endings release the current entry and publish only a safe reason', async () => {
  for (const kind of ['aborted', 'ended', 'listener_error', 'failed']) {
    const end = deferred();
    const watches = new Map();
    const entry = { stream: { closed: end.promise } };
    watches.set('conversation', entry);
    const reasons = [];
    const tracked = trackConversationStream({
      key: 'conversation',
      entry,
      watches,
      onUnexpectedEnd: reason => reasons.push(reason),
    });

    end.resolve({ kind, error: new Error('private detail') });
    await tracked;

    assert.equal(watches.has('conversation'), false, `${kind} releases the stale watch`);
    assert.deepEqual(reasons, [kind], `${kind} crosses the boundary without its error object`);
  }
});

test('an explicit stop releases the entry without presenting a connection error', async () => {
  const end = deferred();
  const watches = new Map();
  const entry = { stream: { closed: end.promise } };
  watches.set('conversation', entry);
  let reported = 0;
  const tracked = trackConversationStream({
    key: 'conversation',
    entry,
    watches,
    onUnexpectedEnd: () => { reported += 1; },
  });

  end.resolve({ kind: 'stopped' });
  await tracked;

  assert.equal(watches.has('conversation'), false);
  assert.equal(reported, 0);
});

test('a late close from an older watch cannot remove or report against its replacement', async () => {
  const end = deferred();
  const watches = new Map();
  const oldEntry = { stream: { closed: end.promise } };
  const replacement = { stream: {} };
  watches.set('conversation', oldEntry);
  const tracked = trackConversationStream({
    key: 'conversation',
    entry: oldEntry,
    watches,
    onUnexpectedEnd: () => assert.fail('stale watch must stay silent'),
  });
  watches.set('conversation', replacement);

  end.resolve({ kind: 'failed', error: new Error('stale') });
  await tracked;

  assert.equal(watches.get('conversation'), replacement);
});

test('a rejected close promise is treated as a failed stream without leaking its error', async () => {
  const watches = new Map();
  const entry = {
    stream: {
      closed: Promise.reject(new Error('private transport failure')),
    },
  };
  watches.set('conversation', entry);
  const reasons = [];
  await trackConversationStream({
    key: 'conversation',
    entry,
    watches,
    onUnexpectedEnd: reason => reasons.push(reason),
  });

  assert.equal(watches.has('conversation'), false);
  assert.deepEqual(reasons, ['failed']);
});
