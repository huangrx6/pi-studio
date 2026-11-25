/** Extension UI data only. Installs and trust mutations are never performed. */
export function installExtensionListFixture() {
  const api = window.piApi;
  const baseSettings = api.settings;
  const calls = [];
  const longName = '团队发布检查与项目依赖审查扩展——用于验证很长名称在窄窗口中完整换行，包含跨工作区协作、审查记录归档与发布前完整性验证';
  const makeItem = (id, name, extra = {}) => ({
    id, name, version: '1.2.3', scope: 'user', tier: 'user', source: `/qa/extensions/${id}`,
    manifest: { format: 1, id, name, version: '1.2.3', description: '检查项目依赖并提供可追溯的发布清单。', author: 'QA Publisher', permissions: ['agent.tools', 'network', 'provider.credentials'], runtime: { durableEntry: './index.cjs' }, contributes: { tools: [], commands: [], panels: [], settings: [], composer: [], dataSources: [] } },
    enabled: true, trusted: true, contentHash: 'qa-content-hash', installedAt: 1, updatedAt: 1, runtimeName: id, runtimeNames: [id], available: true, health: 'ready', blockedReason: '', requirements: [], dependents: [], activeDependents: [], missingDependencies: [], disabledDependencies: [], untrustedDependencies: [], unavailableDependencies: [], cycleDependencies: [], canDisable: true, canRemove: true, disableBlockedReason: '', removeBlockedReason: '', manageBlockedReason: '', commandIds: [], panelIds: [], dataSourceIds: [], ...extra,
  });
  const installed = [
    makeItem('qa.long-extension-id-that-belongs-in-details-only', longName),
    makeItem('qa.untrusted', '项目来源扩展', { scope: 'project', tier: 'project', trusted: false, available: false, health: 'untrusted', blockedReason: '项目扩展尚未信任，主进程代码不会加载。' }),
    makeItem('qa.diagram', '图表工作台', { origin: 'plugin', ownerPluginId: 'qa.diagrams', managed: true, canRemove: false, removeBlockedReason: '由插件统一卸载。' }),
    makeItem('qa.core', '内置依赖能力', { scope: 'builtin', tier: 'core', canDisable: false, canRemove: false, disableBlockedReason: '其他已启用能力依赖此扩展。' }),
  ];
  const mode = new URLSearchParams(location.search).get('library');
  const visible = mode === 'empty' ? [] : mode === 'builtins' ? installed.filter(item => item.scope === 'builtin') : installed;
  window.__extensionQa = { calls, longName };
  const settings = async cwd => ({ ...await baseSettings(cwd), extensions: structuredClone(visible), extensionErrors: [], extensionRegistryUrl: '' });
  Object.assign(api, {
    settings,
    extensionPublisherTrust: async () => ({ publishers: [{ publisher: 'QA Publisher', keys: [{ keyId: 'qa-fixture-key', status: 'trusted' }] }] }),
    setExtensionEnabled: async input => {
      calls.push({ method: 'setExtensionEnabled', ...input });
      const item = visible.find(entry => entry.id === input.id);
      item.enabled = input.enabled;
      item.available = input.enabled && item.trusted;
      return { committed: true, recoveryToken: `qa-toggle-${calls.length}`, projection: { status: 'ready', value: await settings(input.cwd) } };
    },
    pickExtensionSource: async () => '/qa/extensions/preview',
    prepareExtensionInstall: async ({ source, scope }) => ({
      id: 'qa.preview', name: '项目检查', version: '2.0.0', publisher: 'QA Publisher', token: 'qa-preview',
      executable: true, permissions: ['agent.tools', 'network'], addedPermissions: ['agent.tools', 'network'],
      providerAccess: [], addedProviderAccess: [], requires: [], addedRequirements: [], missingDependencies: [],
      scope, sourceKind: 'local-directory', source, treeSha256: 'qa-hash', signatureStatus: 'unsigned', publisherTrust: 'not-applicable',
    }),
    installExtension: async () => { throw new Error('This fixture only previews installs'); },
  });
}
