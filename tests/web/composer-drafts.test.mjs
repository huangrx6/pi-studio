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
  });
  saveComposerDraft(drafts, second, {
    text: 'second draft',
    attachments: [],
  });

  assert.equal(readComposerDraft(drafts, first).text, 'first draft');
  assert.equal(readComposerDraft(drafts, first).attachments[0].name, 'screen.png');
  assert.equal(readComposerDraft(drafts, second).text, 'second draft');
});

test('clearing a sent draft leaves other conversations untouched', () => {
  const drafts = new Map();
  const first = composerDraftKeyForSession('session-a');
  const second = composerDraftKeyForSession('session-b');
  saveComposerDraft(drafts, first, { text: 'sent', attachments: [] });
  saveComposerDraft(drafts, second, { text: 'keep me', attachments: [] });

  clearComposerDraft(drafts, first);

  assert.equal(readComposerDraft(drafts, first).text, '');
  assert.equal(readComposerDraft(drafts, second).text, 'keep me');
});

test('a new conversation draft migrates to its durable id after creation', () => {
  const drafts = new Map();
  const newKey = composerDraftKeyForNew('/workspace');
  const sessionKey = composerDraftKeyForSession('session-created');
  saveComposerDraft(drafts, newKey, {
    text: 'create this',
    attachments: [image],
  });

  moveComposerDraft(drafts, newKey, sessionKey, readComposerDraft(drafts, newKey));

  assert.equal(drafts.has(newKey), false);
  assert.equal(readComposerDraft(drafts, sessionKey).text, 'create this');
  assert.equal(readComposerDraft(drafts, sessionKey).attachments.length, 1);
});

test('empty ordinary drafts are not retained in memory', () => {
  const drafts = new Map();
  const key = composerDraftKeyForSession('session-a');
  saveComposerDraft(drafts, key, { text: '', attachments: [] });
  assert.equal(drafts.has(key), false);
});
