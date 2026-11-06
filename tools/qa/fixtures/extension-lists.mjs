/** Extension UI data only. Installs and trust mutations are never performed. */
export function installExtensionListFixture() {
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
    makeItem('qa.core', '内置依赖能力', { scope: 'builtin', tier: 'core', canDisable: false, canRemove: false, disableBlockedReason: '其他已启用能力依赖此扩展。' }),
  ];
  const makeOfficial = (id, name, extra = {}) => ({ id, name, version: '2.0.0', description: '展示项目检查结果，并保留明确的权限确认步骤。', publisher: 'Pi Studio QA', keywords: ['qa', 'fixture'], permissions: ['ui.panels', 'ui.commands', 'ui.data', 'agent.tools', 'agent.hooks', 'network', 'provider.credentials'], providerAccess: ['qa-provider'], requires: [], executable: true, sha256: 'qa-hash', installed: false, officialManaged: false, updateAvailable: false, autoUpdate: false, requiresPermissionConsent: false, requiresCapabilityConsent: false, addedPermissions: [], addedProviderAccess: [], addedRequirements: [], executableExpansion: false, ...extra });
  const official = [
    makeOfficial('qa.official', '官方项目检查扩展'),
    makeOfficial('qa.update', '可更新的官方扩展', { installed: true, officialManaged: true, installedVersion: '1.0.0', updateAvailable: true, autoUpdate: true, requiresCapabilityConsent: true, addedPermissions: ['network'], executableExpansion: true }),
    makeOfficial('qa.conflict', '存在来源冲突的扩展', { installed: true }),
    makeOfficial('qa.current', '已安装的官方扩展', { installed: true, officialManaged: true, autoUpdate: true }),
  ];
  const settings = () => ({ providers: [], customModels: [], mcp: [], skills: [], extensions: installed, extensionErrors: [], extensionRegistryUrl: '' });
  const model = { modelRef: '', label: '', thinkingLevel: 'default', thinkingLevels: ['default'], effectiveThinkingLevel: 'off' };
  window.__extensionQa = { calls, longName };
  localStorage.setItem('pi-studio:preferences', JSON.stringify({ theme: 'light' }));
  window.piApi = new Proxy({
    state: async () => ({ workspaces: [], model }),
    settings: async () => settings(),
    models: async () => ({ models: [], enabled: [], selection: model, defaultSelection: model }),
    officialExtensions: async () => ({ extensions: official, errors: [], updatedAt: Date.now(), autoUpdate: { updated: [], results: [{ id: 'qa.update', version: '2.0.0', status: 'consent-required' }] } }),
    extensionPublisherTrust: async () => ({ publishers: [] }),
    setExtensionEnabled: async (input) => { calls.push({ method: 'setExtensionEnabled', ...input }); const item = installed.find((entry) => entry.id === input.id); item.enabled = input.enabled; item.available = item.enabled && item.trusted; return { committed: true, recoveryToken: `qa-toggle-${calls.length}`, projection: { status: 'ready', value: settings() } }; },
    disposeExtensionMutationRecovery: async (token) => { calls.push({ method: 'disposeExtensionMutationRecovery', token }); },
    setOfficialExtensionAutoUpdate: async (input) => { calls.push({ method: 'setOfficialExtensionAutoUpdate', ...input }); const item = official.find((entry) => entry.id === input.id); item.autoUpdate = input.enabled; return item; },
    prepareOfficialExtension: async (id) => {
      calls.push({ method: 'prepareOfficialExtension', id });
      const item = official.find((entry) => entry.id === id);
      return { ...item, token: `qa-preview-${id}`, scope: 'user', permissions: item.permissions, addedPermissions: item.permissions, providerAccess: ['qa-provider'], requires: [], addedRequirements: [], missingDependencies: [], addedProviderAccess: ['qa-provider'], sourceKind: 'official', source: 'qa-fixture', resolvedRef: null, archiveSha256: null, treeSha256: 'qa-hash', integrityFileSha256: 'qa-hash', signatureStatus: 'unsigned', publisherTrust: 'not-applicable', requiresPublisherTrust: false, upgrade: item.updateAvailable, alreadyInstalled: item.installed };
    },
    disposeExtensionInstall: async (token) => { calls.push({ method: 'disposeExtensionInstall', token }); },
    installExtension: async () => { throw new Error('QA must not install extensions'); },
    modeGet: async () => ({ available: true, mode: 'smart' }),
    composerResources: async () => ({ commands: [], skills: [] }),
    extensionsUi: async () => ({ items: [], errors: [], syncedAt: Date.now(), apiVersion: 1 }),
  }, { get(target, key) { if (key in target) return target[key]; if (String(key).startsWith('on')) return () => () => {}; return async () => undefined; } });
}
