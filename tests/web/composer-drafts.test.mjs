import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearComposerDraft,
  composerDraftKeyForNew,
  composerDraftKeyForSession,
  moveComposerDraft,
  readComposerDraft,
  saveComposerDraft,
} from '../../web/src/lib/composer-drafts.ts';

const image = {
  id: 'image-1',
  kind: 'image',
  name: 'screen.png',
  mime: 'image/png',
  bytes: 12,
  data: 'ZmFrZQ==',
};

test('composer drafts stay isolated by conversation', () => {
  const drafts = new Map();
  const first = composerDraftKeyForSession('session-a');
  const second = composerDraftKeyForSession('session-b');

  saveComposerDraft(drafts, first, {
    text: 'first draft',
    attachments: [image],
    kind: 'conversation',
  });
  saveComposerDraft(drafts, second, {
    text: 'second draft',
    attachments: [],
    kind: 'durable',
  });

  assert.equal(readComposerDraft(drafts, first, 'conversation').text, 'first draft');
  assert.equal(readComposerDraft(drafts, first, 'conversation').attachments[0].name, 'screen.png');
  assert.equal(readComposerDraft(drafts, second, 'conversation').text, 'second draft');
  assert.equal(readComposerDraft(drafts, second, 'conversation').kind, 'durable');
});

test('clearing a sent draft leaves other conversations untouched', () => {
  const drafts = new Map();
  const first = composerDraftKeyForSession('session-a');
  const second = composerDraftKeyForSession('session-b');
  saveComposerDraft(drafts, first, { text: 'sent', attachments: [], kind: 'conversation' });
  saveComposerDraft(drafts, second, { text: 'keep me', attachments: [], kind: 'conversation' });

  clearComposerDraft(drafts, first);

  assert.equal(readComposerDraft(drafts, first, 'conversation').text, '');
  assert.equal(readComposerDraft(drafts, second, 'conversation').text, 'keep me');
});

test('a new conversation draft migrates to its durable id after creation', () => {
  const drafts = new Map();
  const newKey = composerDraftKeyForNew('/workspace');
  const sessionKey = composerDraftKeyForSession('session-created');
  saveComposerDraft(drafts, newKey, {
    text: 'create this',
    attachments: [image],
    kind: 'conversation',
  });

  moveComposerDraft(drafts, newKey, sessionKey, readComposerDraft(drafts, newKey, 'conversation'));

  assert.equal(drafts.has(newKey), false);
  assert.equal(readComposerDraft(drafts, sessionKey, 'conversation').text, 'create this');
  assert.equal(readComposerDraft(drafts, sessionKey, 'conversation').attachments.length, 1);
});

test('empty ordinary drafts are not retained in memory', () => {
  const drafts = new Map();
  const key = composerDraftKeyForSession('session-a');
  saveComposerDraft(drafts, key, { text: '', attachments: [], kind: 'conversation' });
  assert.equal(drafts.has(key), false);
});
