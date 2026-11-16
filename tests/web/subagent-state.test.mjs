import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeSubagentChild,
  mergeSubagentChildren,
  orderProgressAgents,
  reconcileSubagentStatus,
} from '../../web/src/features/subagents/subagent-state.ts';

function child(key, status, extra = {}) {
  return {
    key,
    runId: key,
    index: 0,
    agent: 'subagent',
    task: 'query weather',
    status,
    source: 'foreground',
    model: 'deepseek/deepseek-flash',
    thinking: 'off',
    cwd: '/tmp',
    preview: '',
    hasTranscript: true,
    ...extra,
  };
}

test('an authoritative terminal status replaces a stale running cache', () => {
  assert.equal(reconcileSubagentStatus('running', 'failed'), 'failed');
  assert.equal(
    mergeSubagentChild(
      child('conversation:102', 'running'),
      child('conversation:102', 'failed'),
    ).status,
    'failed',
  );
});

test('a late running projection cannot reopen a terminal child', () => {
  for (const status of ['completed', 'failed', 'stopped']) {
    assert.equal(reconcileSubagentStatus(status, 'running'), status);
  }
});

test('the child list follows the latest endpoint membership and order', () => {
  const current = [
    child('conversation:59', 'completed', { preview: 'cached' }),
    child('conversation:101', 'running'),
  ];
  const incoming = [child('conversation:102', 'failed')];
  const merged = mergeSubagentChildren(current, incoming);

  assert.deepEqual(merged.map((item) => item.key), ['conversation:102']);
  assert.equal(merged[0].status, 'failed');
  assert.equal(mergeSubagentChildren(current, []).length, 0);
});

test('same-child refresh keeps a known transcript flag', () => {
  const merged = mergeSubagentChildren(
    [child('conversation:102', 'running', { hasTranscript: true })],
    [child('conversation:102', 'failed', { hasTranscript: false })],
  );

  assert.equal(merged[0].status, 'failed');
  assert.equal(merged[0].hasTranscript, true);
});

test('progress prioritizes open questions then active runs without changing overview order', () => {
  const rows = [child('done', 'completed'), child('busy', 'running'), child('reply', 'waiting'), child('next', 'pending')];
  assert.deepEqual(orderProgressAgents(rows).map(row => row.key), ['reply', 'busy', 'next', 'done']);
  assert.equal(rows[0].key, 'done');
  const reused = mergeSubagentChild(child('same', 'completed', { runId: '4', durationMs: 100, avatarId: 'koala-ice' }),
    child('same', 'running', { runId: '7', avatarId: 'koala-ice' }));
  assert.equal(reused.status, 'running');
  assert.equal(reused.avatarId, 'koala-ice');
  assert.equal(reused.durationMs, undefined);
});
