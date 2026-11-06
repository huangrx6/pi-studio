import assert from 'node:assert/strict';
import test from 'node:test';

import {
  markRejectedQueuedSubmission,
  mergeRejectedComposerDraft,
  queuedSubmissionMatches,
  removeAdmittedQueuedSubmission,
} from '../../web/src/features/conversation/composer-delivery.mjs';

const attachment = (id, name = id) => ({
  id,
  kind: 'file',
  name,
  mime: 'text/plain',
  bytes: 10,
  path: `/tmp/${name}`,
});

test('rejected drafts restore their original text and attachments exactly', () => {
  const original = {
    text: 'original message',
    attachments: [attachment('original')],
  };
  assert.deepEqual(
    mergeRejectedComposerDraft({ text: '', attachments: [] }, original),
    original,
  );
});

test('rejected drafts merge ahead of edits made while admission was pending without duplicating attachments', () => {
  const restored = mergeRejectedComposerDraft(
    {
      text: 'typed while waiting',
      attachments: [attachment('waiting'), attachment('original')],
    },
    {
      text: 'original message',
      attachments: [attachment('original')],
    },
  );
  assert.equal(restored.text, 'original message\n\ntyped while waiting');
  assert.deepEqual(restored.attachments.map(item => item.id), ['original', 'waiting']);
});

test('queue cleanup targets the request id rather than a reused row id', () => {
  const admitted = {
    id: 'row-1',
    order: 1,
    text: 'old request',
    submission: { requestId: 'request-old' },
  };
  const edited = {
    id: 'row-1',
    order: 1,
    text: 'edited request',
    submission: { requestId: 'request-new' },
  };
  const second = {
    id: 'row-2',
    order: 2,
    text: 'second',
    submission: { requestId: 'request-2' },
  };

  assert.equal(queuedSubmissionMatches(edited, 'row-1', 'request-old'), false);
  assert.deepEqual(
    removeAdmittedQueuedSubmission([edited, second], 'row-1', 'request-old'),
    [edited, second],
  );
  assert.deepEqual(
    removeAdmittedQueuedSubmission([admitted, second], 'row-1', 'request-old'),
    [second],
  );

  const rejected = markRejectedQueuedSubmission(
    [admitted, second],
    'row-1',
    'request-old',
    'Durable rejected the request',
  );
  assert.equal(rejected[0].autoRetryError, 'Durable rejected the request');
  assert.equal(rejected[1].autoRetryError, undefined);
  assert.equal(rejected[0].order, 1);
  assert.equal(rejected[1].order, 2);

  assert.deepEqual(
    markRejectedQueuedSubmission(rejected, 'row-1', 'request-new', 'late failure'),
    rejected,
  );
});
