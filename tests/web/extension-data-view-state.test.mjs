import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptsExtensionDataViewSnapshot,
  extensionDataViewRequestKey,
} from '../../web/src/features/extensions/extension-data-view-state.ts';

const snapshot = (revision, text = `revision ${revision}`) => ({
  sourceId: 'project:live/metrics',
  revision,
  updatedAt: revision,
  content: [{ kind: 'text', text }],
});

test('live data ownership keys distinguish source, workspace, session, and model', () => {
  const initial = extensionDataViewRequestKey('project:live/metrics', '/a', 'one', 'model:a');
  const variants = [
    extensionDataViewRequestKey('project:live/other', '/a', 'one', 'model:a'),
    extensionDataViewRequestKey('project:live/metrics', '/b', 'one', 'model:a'),
    extensionDataViewRequestKey('project:live/metrics', '/a', 'two', 'model:a'),
    extensionDataViewRequestKey('project:live/metrics', '/a', 'one', 'model:b'),
  ];
  assert.equal(new Set([initial, ...variants]).size, 5);
  assert.equal(
    extensionDataViewRequestKey('project:live/metrics', '/a', 'one', 'model:a'),
    initial,
  );
});

test('revisions are ordered only within the same live subscription', () => {
  const current = { subscriptionId: 'subscription-a', snapshot: snapshot(5) };
  assert.equal(
    acceptsExtensionDataViewSnapshot(current, 'subscription-a', snapshot(6)),
    true,
  );
  assert.equal(
    acceptsExtensionDataViewSnapshot(current, 'subscription-a', snapshot(5, 'same revision')),
    true,
  );
  assert.equal(
    acceptsExtensionDataViewSnapshot(current, 'subscription-a', snapshot(4)),
    false,
  );
});

test('a retry with a new subscription accepts its lower revision and replaces stale data', () => {
  const stale = { subscriptionId: 'subscription-a', snapshot: snapshot(12) };
  assert.equal(
    acceptsExtensionDataViewSnapshot(stale, 'subscription-b', snapshot(1, 'fresh after retry')),
    true,
  );
  assert.equal(
    acceptsExtensionDataViewSnapshot(null, 'subscription-b', snapshot(1)),
    true,
  );
});
