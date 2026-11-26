import assert from 'node:assert/strict';
import test from 'node:test';
import { activityKind } from '../../web/src/features/conversation/turn-content.ts';

function tool(name, args = {}) {
  return { kind: 'tool', key: name, live: false, call: { type: 'toolCall', id: name, name, arguments: args } };
}

test('browser tools map to browser activity kind', () => {
  assert.equal(activityKind(tool('browser_open', { url: 'https://example.com' })), 'browser');
  assert.equal(activityKind(tool('browser_snapshot')), 'browser');
  assert.equal(activityKind(tool('browser_click', { ref: 'e1' })), 'browser');
  assert.equal(activityKind(tool('browser_hover', { ref: 'e1' })), 'browser');
  assert.equal(activityKind(tool('browser_type', { ref: 'e2', text: 'hi' })), 'browser');
  assert.equal(activityKind(tool('browser_press', { key: 'Escape' })), 'browser');
  assert.equal(activityKind(tool('browser_drag', { sourceRef: 'e1', targetRef: 'e2' })), 'browser');
  assert.equal(activityKind(tool('browser_viewport', { preset: 'desktop' })), 'browser');
  assert.equal(activityKind(tool('browser_console', { level: 'error' })), 'browser');
  assert.equal(activityKind(tool('browser_network', { failedOnly: true })), 'browser');
  assert.equal(activityKind(tool('browser_wait', { urlIncludes: '/done' })), 'browser');
  assert.equal(activityKind(tool('browser_highlight', { ref: 'e1' })), 'browser');
  assert.equal(activityKind(tool('browser_evaluate', { expression: '1+1' })), 'browser');
  assert.equal(activityKind(tool('read', { path: 'a.ts' })), 'explore');
});
