import assert from 'node:assert/strict';
import test from 'node:test';
import { groupMcpServersByOwnership } from '../../web/src/features/mcp/mcp-ownership.ts';

const server = (name, patch = {}) => ({ name, ...patch });

test('user-only lists stay flat under 用户添加 without forcing plugin headers', () => {
  const groups = groupMcpServersByOwnership([
    server('alpha'),
    server('beta', { origin: 'user', ownerPluginId: '' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ownerPluginId, '');
  assert.equal(groups[0].label, '用户添加');
  assert.deepEqual(groups[0].servers.map((item) => item.name), ['alpha', 'beta']);
});

test('plugin-owned servers group after user-added and sort by plugin id', () => {
  const groups = groupMcpServersByOwnership([
    server('z-plugin', { origin: 'plugin', ownerPluginId: 'com.example.zebra' }),
    server('manual'),
    server('draw', { origin: 'plugin', ownerPluginId: 'com.example.excalidraw', managed: true }),
    server('draw-tools', { origin: 'plugin', ownerPluginId: 'com.example.excalidraw' }),
    server('orphan-plugin-flag', { origin: 'plugin', ownerPluginId: '  ' }),
  ]);
  assert.equal(groups[0].label, '用户添加');
  assert.deepEqual(groups[0].servers.map((item) => item.name), ['manual', 'orphan-plugin-flag']);
  assert.deepEqual(groups.slice(1).map((group) => group.ownerPluginId), [
    'com.example.excalidraw',
    'com.example.zebra',
  ]);
  assert.equal(groups[1].label, '插件 · excalidraw');
  assert.deepEqual(groups[1].servers.map((item) => item.name), ['draw', 'draw-tools']);
});
