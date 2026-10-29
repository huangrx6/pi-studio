import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeSubagentChild,
  mergeSubagentChildren,
  reconcileSubagentStatus,
} from '../../web/src/lib/subagent-state.mjs';

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
