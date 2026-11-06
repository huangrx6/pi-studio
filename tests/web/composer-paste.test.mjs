import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeComposerAttachments, planComposerPaste, recoverComposerPaste } from '../../web/src/features/conversation/composer-paste.ts';
import { readComposerDraft, saveComposerDraft } from '../../web/src/features/conversation/composer-drafts.ts';

const attachment = id => ({ id, kind: 'file', name: `${id}.txt`, mime: 'text/plain', bytes: 1, path: `/fixture/${id}.txt` });

test('failed paste restores at the original selection only while the base is unchanged', () => {
  const pending = planComposerPaste('before SELECT after', 7, 13, 'pasted');
  assert.equal(pending.baseText, 'before  after');
  assert.deepEqual(recoverComposerPaste(pending.baseText, pending), { text: 'before pasted after', appended: false });
});

test('failed paste preserves later editing and recovers the entire pasted batch separately', () => {
  const pending = planComposerPaste('initial', 7, 7, 'very long paste');
  const result = recoverComposerPaste('new input typed while saving', pending);
  assert.equal(result.text, 'new input typed while saving\n\nvery long paste');
  assert.equal(result.appended, true);
  assert.equal(recoverComposerPaste('', pending).text, 'very long paste');
});

test('a delayed failure belongs to its original conversation, preserving both drafts and attachments', () => {
  const store = new Map();
  const pending = planComposerPaste('A', 1, 1, 'paste');
  saveComposerDraft(store, 'A', { text: pending.baseText, attachments: [attachment('a')] });
  saveComposerDraft(store, 'B', { text: 'B later input', attachments: [attachment('b')] });
  const currentA = readComposerDraft(store, 'A');
  saveComposerDraft(store, 'A', { ...currentA, text: recoverComposerPaste(currentA.text, pending).text });
  assert.equal(readComposerDraft(store, 'A').text, 'Apaste');
  assert.equal(readComposerDraft(store, 'A').attachments[0].id, 'a');
  assert.equal(readComposerDraft(store, 'B').text, 'B later input');
  assert.equal(readComposerDraft(store, 'B').attachments[0].id, 'b');
});

test('out-of-order completions merge latest attachments and never revive a removed original', () => {
  const store = new Map();
  saveComposerDraft(store, 'A', { text: 'keep latest text', attachments: [attachment('removed')] });
  const complete = id => saveComposerDraft(store, 'A', mergeComposerAttachments(readComposerDraft(store, 'A'), [attachment(id)]));
  // Both requests started before the existing attachment was removed.
  saveComposerDraft(store, 'A', { text: 'typed after requests started', attachments: [] });
  complete('second');
  complete('first');
  complete('first');
  const final = readComposerDraft(store, 'A');
  assert.deepEqual(final.attachments.map(item => item.id), ['second', 'first']);
  assert.equal(final.text, 'typed after requests started');
});

test('multiple failed batches preserve earlier recovered content instead of overwriting it', () => {
  const first = planComposerPaste('base', 4, 4, 'first');
  const second = planComposerPaste('base', 4, 4, 'second');
  const recoveredSecond = recoverComposerPaste('base', second).text;
  const recoveredFirst = recoverComposerPaste(recoveredSecond, first).text;
  assert.equal(recoveredFirst, 'basesecond\n\nfirst');
});
