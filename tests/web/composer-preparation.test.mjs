import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composerDraftMatches,
  retainedComposerRequestId,
  snapshotComposerDraft,
} from '../../web/src/features/conversation/composer-preparation.ts';
import { moveComposerDraft, readComposerDraft, saveComposerDraft } from '../../web/src/features/conversation/composer-drafts.ts';

const file = id => ({ id, kind: 'file', name: `${id}.txt`, mime: 'text/plain', bytes: 2, path: `/fixture/${id}` });

test('preparation only consumes the exact text and ordered attachments it captured', () => {
  const original = snapshotComposerDraft({ text: 'send me', attachments: [file('one'), file('two')] });
  assert.equal(composerDraftMatches({ text: 'send me', attachments: [file('one'), file('two')] }, original), true);
  assert.equal(composerDraftMatches({ text: 'send me plus edits', attachments: original.attachments }, original), false);
  assert.equal(composerDraftMatches({ text: 'send me', attachments: [file('one')] }, original), false);
  assert.equal(composerDraftMatches({ text: 'send me', attachments: [file('two'), file('one')] }, original), false);
  assert.equal(composerDraftMatches({ text: 'send me', attachments: [...original.attachments, file('three')] }, original), false);
});

test('snapshot comparison detects changed image data and file metadata without JSON serialization', () => {
  const current = { text: '', attachments: [{ id: 'image', kind: 'image', name: 'a.png', mime: 'image/png', bytes: 3, data: 'old' }] };
  const original = snapshotComposerDraft(current);
  current.attachments[0].data = 'new';
  assert.equal(original.attachments[0].data, 'old');
  assert.equal(composerDraftMatches(current, original), false);
  const originalFile = snapshotComposerDraft({ text: '', attachments: [file('one')] });
  assert.equal(composerDraftMatches({ text: '', attachments: [{ ...file('one'), marker: 'new marker' }] }, originalFile), false);
});

test('conversation creation migrates the latest draft and stops the earlier preparation when it changed', () => {
  const store = new Map();
  const original = snapshotComposerDraft({ text: 'first version', attachments: [file('one')] });
  saveComposerDraft(store, 'new:workspace', original);
  saveComposerDraft(store, 'new:workspace', { text: 'latest version', attachments: [file('two')] });
  moveComposerDraft(store, 'new:workspace', 'session:created', readComposerDraft(store, 'new:workspace'));
  assert.equal(store.has('new:workspace'), false);
  const latest = readComposerDraft(store, 'session:created');
  assert.equal(latest.text, 'latest version');
  assert.deepEqual(latest.attachments.map(item => item.id), ['two']);
  assert.equal(composerDraftMatches(latest, original), false);
});

test('a retry reuses its request id only for the exact rejected draft', () => {
  const original = snapshotComposerDraft({ text: 'retry exactly', attachments: [file('one')] });
  const retry = { draft: original, requestId: 'stable-request-id' };
  assert.equal(retainedComposerRequestId(retry, original), 'stable-request-id');
  assert.equal(retainedComposerRequestId(retry, {
    text: 'retry exactly',
    attachments: [file('two')],
  }), undefined);
  assert.equal(retainedComposerRequestId(undefined, original), undefined);
});
