import assert from 'node:assert/strict';
import test from 'node:test';

const {
  isPluginOwnedResource,
  pluginOwnershipBadge,
  pluginOwnershipLabel,
  pluginOwnershipSourceLine,
} = await import('../../web/src/shared/plugin-ownership.ts');

test('plugin ownership labels prefer the last dotted segment', () => {
  assert.equal(pluginOwnershipLabel('com.example.excalidraw'), 'excalidraw');
  assert.equal(pluginOwnershipLabel('toolkit-starter'), 'toolkit-starter');
  assert.equal(pluginOwnershipLabel('  '), '插件');
});

test('plugin ownership badges distinguish managed and attached resources', () => {
  assert.equal(isPluginOwnedResource({ origin: 'user' }), false);
  assert.equal(isPluginOwnedResource({ origin: 'plugin', ownerPluginId: 'example.toolkit' }), true);
  assert.equal(
    pluginOwnershipBadge({ origin: 'plugin', ownerPluginId: 'example.toolkit', managed: true }),
    '插件托管 · toolkit',
  );
  assert.equal(
    pluginOwnershipBadge({
      origin: 'plugin',
      ownerPluginId: 'example.toolkit',
      managed: false,
      userOverride: true,
    }),
    '插件附带 · toolkit · 已改配置',
  );
  assert.equal(
    pluginOwnershipSourceLine({ origin: 'plugin', ownerPluginId: 'com.example.board' }),
    '来自插件 · board',
  );
});
