import assert from 'node:assert/strict';
import test from 'node:test';
import { composerSubmitAction } from '../../web/src/lib/composer-submit.ts';

const enter = {
  key: 'Enter',
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
};

test('Enter supplements a running task and sends normally while idle', () => {
  assert.equal(composerSubmitAction({ ...enter, busy: true }), 'steer');
  assert.equal(composerSubmitAction({ ...enter, busy: false }), 'send');
});

test('Cmd/Ctrl+Enter queues the current draft without releasing existing queued items', () => {
  assert.equal(composerSubmitAction({ ...enter, ctrlKey: true, busy: true }), 'queue');
  assert.equal(composerSubmitAction({ ...enter, metaKey: true, busy: true }), 'queue');
  assert.equal(composerSubmitAction({ ...enter, ctrlKey: true, busy: false }), 'send');
});

test('modified and composing Enter keys retain their native textarea behavior', () => {
  assert.equal(composerSubmitAction({ ...enter, shiftKey: true, busy: true }), 'none');
  assert.equal(composerSubmitAction({ ...enter, altKey: true, busy: true }), 'none');
  assert.equal(composerSubmitAction({ ...enter, isComposing: true, busy: true }), 'none');
  assert.equal(composerSubmitAction({ ...enter, key: 'a', busy: true }), 'none');
});
