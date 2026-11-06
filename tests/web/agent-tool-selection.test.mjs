import test from 'node:test';
import assert from 'node:assert/strict';
import { patternMatches, sameToolNames, toggleToolSelection, selectionFromSources } from '../../web/src/features/tools/agent-tool-selection.ts';

test('tool patterns match literal punctuation and arbitrary wildcard positions', () => {
  assert.equal(patternMatches('mcp__docs__*', 'mcp__docs__search'), true);
  assert.equal(patternMatches('tool.v1', 'toolXv1'), false);
  assert.equal(patternMatches('a.*.z', 'a.x.z'), true);
  assert.equal(patternMatches('a.*.z', 'aXxXz'), false);
});

test('disabling wildcard member preserves known siblings and unrelated unresolved rules without duplicate entries', () => {
  const next = toggleToolSelection(['*', 'read', 'mcp__*', 'future_tool'], ['read', 'write', 'mcp__docs', 'mcp__docs'], 'read', false);
  assert.deepEqual(next, ['mcp__*', 'future_tool', 'write', 'mcp__docs']);
  assert.equal(next.some(rule => patternMatches(rule, 'read')), false);
  assert.equal(next.some(rule => patternMatches(rule, 'new_core_tool')), false);
});

test('allowing an already covered tool keeps the wildcard and disabling explicit entries leaves unrelated patterns', () => {
  assert.deepEqual(toggleToolSelection(['mcp__*'], [], 'mcp__docs', true), ['mcp__*']);
  assert.deepEqual(toggleToolSelection(['read', 'mcp__*'], [], 'read', false), ['mcp__*']);
});

test('recommended reset detection is order independent and rejects duplicate names', () => {
  assert.equal(sameToolNames(['write', 'read'], ['read', 'write']), true);
  assert.equal(sameToolNames(['read', 'read'], ['read', 'write']), false);
  assert.equal(sameToolNames(['read'], ['read', 'write']), false);
});

test('missing sources survive catalog refresh; removed names do not retain stale metadata', () => {
  const source = { source: 'extension:test', label: 'Test', scope: 'project', path: 'tool', baseDir: 'ext' };
  const previous = { enabled: ['missing', 'removed'], sources: { missing: source, removed: source } };
  const next = selectionFromSources(['missing', 'new'], {}, previous);
  assert.deepEqual(next.sources.missing, source);
  assert.equal(next.sources.removed, undefined);
  assert.equal(next.sources.new.source, 'manual');
});
