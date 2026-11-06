import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelPickerRequests } from '../../web/src/features/models/model-picker-requests.ts';

test('closing/reopening invalidates callbacks while preserving the in-flight write lock', () => {
  const requests = createModelPickerRequests();
  requests.invalidate();
  const ticket = requests.beginSave('session:a');
  assert.equal(requests.canPublish(ticket, 'session:a'), true);
  requests.invalidate();
  requests.invalidate();
  assert.equal(requests.canPublish(ticket, 'session:a'), false);
  assert.equal(requests.beginSave('session:a'), null);
  requests.finishSave(ticket);
  assert.equal(requests.isSaving('session:a'), false);
  assert.ok(requests.beginSave('session:a'));
});

test('saves in another context cannot clear each other or publish stale feedback', () => {
  const requests = createModelPickerRequests();
  const old = requests.beginSave('session:a');
  requests.invalidate();
  const current = requests.beginSave('session:b');
  assert.equal(requests.canPublish(old, 'session:b'), false);
  requests.finishSave(old);
  assert.equal(requests.isSaving('session:b'), true);
  assert.equal(requests.canPublish(current, 'session:b'), true);
});

test('a repeated completion cannot release a later save in the same context', () => {
  const requests = createModelPickerRequests();
  const first = requests.beginSave('default:workspace');
  requests.finishSave(first);
  const second = requests.beginSave('default:workspace');
  requests.finishSave(first);
  assert.equal(requests.isSaving('default:workspace'), true);
  assert.equal(requests.canPublish(first, 'default:workspace'), false);
  assert.equal(requests.canPublish(second, 'default:workspace'), true);
});

test('directory generations reject old results after a new opening or context', () => {
  const requests = createModelPickerRequests();
  const old = requests.invalidate();
  const current = requests.invalidate();
  assert.equal(requests.current(old), false);
  assert.equal(requests.current(current), true);
});
