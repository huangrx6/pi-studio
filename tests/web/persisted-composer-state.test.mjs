import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESTORED_QUEUE_NOTICE,
  buildPersistedComposerInputState,
  restoreComposerInputState,
} from '../../web/src/features/conversation/persisted-composer-state.ts';

const image = {
  id: 'image-1',
  kind: 'image',
  name: 'screen.png',
  mime: 'image/png',
  bytes: 12,
  data: 'ZmFrZQ==',
};

const file = {
  id: 'file-1',
  kind: 'file',
  name: 'notes.txt',
  mime: 'text/plain',
  bytes: 128,
  lines: 4,
  path: '/workspace/notes.txt',
  marker: '@notes.txt',
};

function queuedPrompt(overrides = {}) {
  return {
    id: 'queue-1',
    order: 1,
    text: 'send this queue item',
    attachments: [image, file],
    submission: {
      sessionId: 'session-a',
      requestId: 'request-1',
      displayText: 'send this queue item',
      outgoingText: 'send this queue item',
      content: [{ type: 'text', text: 'send this queue item' }],
      persistentAttachments: [{
        name: 'notes.txt',
        path: '/workspace/notes.txt',
        bytes: 128,
        lines: 4,
        kind: 'file',
        mime: 'text/plain',
      }],
      imagePayload: [{ type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }],
      mentions: ['notes.txt'],
      attachmentPaths: ['/workspace/notes.txt'],
    },
    ...overrides,
  };
}

test('drafts and queues round-trip with active target and safe attachments', () => {
  const drafts = new Map([
    ['session:session-a', { text: 'session draft', attachments: [image] }],
    ['session:session-b', { text: 'session b draft', attachments: [] }],
    ['new:/workspace', { text: 'new conversation draft', attachments: [] }],
  ]);
  const snapshot = buildPersistedComposerInputState(
    drafts,
    {
      'session-a': [queuedPrompt()],
      'session-b': [queuedPrompt({
        id: 'queue-2',
        text: 'second session',
        attachments: [],
        submission: {
          ...queuedPrompt().submission,
          sessionId: 'session-b',
          requestId: 'request-2',
          displayText: 'second session',
          outgoingText: 'second session',
          content: [{ type: 'text', text: 'second session' }],
          persistentAttachments: [],
          imagePayload: [],
          mentions: [],
          attachmentPaths: [],
        },
      })],
    },
    'new:/workspace',
    1_700_000_000_000,
  );

  assert.equal(snapshot.activeDraftKey, 'new:/workspace');
  const restored = restoreComposerInputState(snapshot);
  assert.equal(restored.activeDraftKey, 'new:/workspace');
  assert.equal(restored.drafts.get('session:session-a').text, 'session draft');
  assert.equal(restored.drafts.get('session:session-a').attachments[0].data, 'ZmFrZQ==');
  assert.equal(restored.drafts.get('session:session-b').text, 'session b draft');
  assert.equal(restored.drafts.get('new:/workspace').text, 'new conversation draft');
  assert.equal(restored.queues['session-a'].length, 1);
  assert.equal(restored.queues['session-b'][0].text, 'second session');
  assert.equal(restored.queues['session-a'][0].attachments[1].path, '/workspace/notes.txt');
});

test('a restored queue is rebuilt and requires explicit confirmation', () => {
  const snapshot = buildPersistedComposerInputState(
    new Map(),
    { 'session-a': [queuedPrompt()] },
    'session:session-a',
  );
  const item = restoreComposerInputState(snapshot).queues['session-a'][0];

  assert.equal(item.autoRetryError, RESTORED_QUEUE_NOTICE);
  assert.equal(item.submission.sessionId, 'session-a');
  assert.equal(item.submission.requestId, 'request-1');
  assert.deepEqual(item.submission.imagePayload, [{
    type: 'image',
    data: 'ZmFrZQ==',
    mimeType: 'image/png',
  }]);
  assert.deepEqual(item.submission.attachmentPaths, ['/workspace/notes.txt']);
  assert.deepEqual(item.submission.content, [
    { type: 'text', text: 'send this queue item' },
    { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' },
  ]);
});

test('invalid draft keys, attachments and unsafe paths are discarded', () => {
  const restored = restoreComposerInputState({
    version: 1,
    activeDraftKey: 'session:constructor',
    drafts: [
      { key: 'new:relative/path', text: 'relative', attachments: [], updatedAt: 1 },
      { key: 'session:__proto__', text: 'reserved', attachments: [], updatedAt: 2 },
      {
        key: 'session:session-a',
        text: 'kept',
        attachments: [
          { id: 'bad-image', kind: 'image', name: 'bad.png', mime: 'image/png', bytes: 1 },
          { id: 'bad-file', kind: 'file', name: 'bad.txt', mime: 'text/plain', bytes: 1, path: 'relative.txt' },
        ],
        updatedAt: 3,
      },
    ],
    queues: [],
  });

  assert.equal(restored.activeDraftKey, '');
  assert.deepEqual([...restored.drafts.keys()], ['session:session-a']);
  assert.deepEqual(restored.drafts.get('session:session-a').attachments, []);
});

test('duplicate queue ids and request ids are retained only once', () => {
  const duplicateId = queuedPrompt({
    id: 'queue-1',
    submission: { ...queuedPrompt().submission, requestId: 'request-2' },
  });
  const duplicateRequest = queuedPrompt({ id: 'queue-2' });
  const restored = restoreComposerInputState({
    version: 1,
    activeDraftKey: '',
    drafts: [],
    queues: [{
      sessionId: 'session-a',
      updatedAt: 1,
      items: [
        queuedPrompt(),
        duplicateId,
        duplicateRequest,
      ],
    }],
  });

  assert.deepEqual(
    restored.queues['session-a'].map(item => [item.id, item.submission.requestId]),
    [['queue-1', 'request-1']],
  );
});

test('reserved session ids and oversized text are discarded', () => {
  const restored = restoreComposerInputState({
    version: 1,
    activeDraftKey: '',
    drafts: [],
    queues: [{
      sessionId: 'prototype',
      updatedAt: 1,
      items: [queuedPrompt()],
    }, {
      sessionId: 'session-a',
      updatedAt: 2,
      items: [queuedPrompt({
        attachments: [],
        text: 'x'.repeat(2_000_001),
        submission: {
          ...queuedPrompt().submission,
          displayText: 'x'.repeat(2_000_001),
          outgoingText: 'x'.repeat(2_000_001),
          persistentAttachments: [],
          imagePayload: [],
          mentions: [],
          attachmentPaths: [],
        },
      })],
    }],
  });

  assert.deepEqual(restored.queues, {});
});
