import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpConnectionStatus } from '../../web/src/features/mcp/mcp-status.ts';

const server = (patch = {}) => ({ enabled: true, connected: false, error: '', toolCount: 0, ...patch });

test('an enabled server waiting for a connection is not an error', () => {
  assert.deepEqual(mcpConnectionStatus(server()), { state: 'waiting', label: '等待连接' });
  assert.equal(mcpConnectionStatus(server({ error: '  ' })).state, 'waiting');
});
test('disabled servers keep a disabled status even if an older connection failed', () => {
  assert.deepEqual(mcpConnectionStatus(server({ enabled: false, error: 'old failure' })), { state: 'disabled', label: '已停用' });
});
test('actual connection errors remain discoverable and connected zero tools is explicit', () => {
  assert.equal(mcpConnectionStatus(server({ error: 'connection refused' })).state, 'error');
  assert.deepEqual(mcpConnectionStatus(server({ connected: true })), { state: 'connected', label: '已连接 · 0 个工具' });
  assert.equal(mcpConnectionStatus(server({ connected: true, toolCount: 5 })).label, '已连接 · 5 个工具');
});
