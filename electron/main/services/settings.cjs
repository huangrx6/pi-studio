/**
 * Read-only settings projection for the renderer.
 *
 * Every value comes from Studio SQLite or Studio-owned directories. No Pi
 * CLI credential, model, MCP, skill, or extension file is inspected.
 */

const path = require('node:path');
const { attachmentsDirectory } = require('../core/studio-paths.cjs');
const {
  databasePath,
  getStudioDatabase,
} = require('../core/studio-db.cjs');
const {
  getExtensionRegistryUrl,
  getHarnessSettings,
  getPermissionProfilesSnapshot,
} = require('../core/app-settings.cjs');
const { DEFAULT_CWD } = require('../core/state.cjs');
const { modelInfo } = require('./models.cjs');
const {
  discoverSkills,
  projectSkillsDirectory,
  sharedProjectSkillsDirectory,
  sharedUserSkillsDirectory,
  userSkillsDirectory,
} = require('../capabilities/skills/index.cjs');
const {
  extensionHostSnapshot,
  officialExtensionsSnapshot,
  projectExtensionsDirectory,
  userExtensionsDirectory,
} = require('./studio-extensions.cjs');
const {
  agentToolCatalog,
  getToolProfilesSnapshot,
  readAgentToolSelection,
  temporaryCapabilitiesSnapshot,
} = require('../runtime/tool-selection.cjs');
const { mcpSnapshot } = require('../integrations/mcp/index.cjs');
const { listInstalledPlugins } = require('./plugin-distribution.cjs');
const { version: durableVersion } = require('@earendil-works/pi-durable/package.json');

async function settingsSnapshot(cwd = DEFAULT_CWD) {
  const db = getStudioDatabase();
  const providers = db.listProviders();
  const models = db.listModels();
  const credentialIds = new Set((await db.listCredentialsAsync()).map((item) => item.providerId));
  const mcpServers = await db.listMcpServersAsync();
  const oauthStates = new Map(await Promise.all(
    mcpServers
      .filter((server) => server.transport === 'http' && server.url)
      .map(async (server) => [server.url, await db.readMcpOAuthStateAsync(server.url)]),
  ));
  const enabledProviderIds = new Set(providers.filter((provider) => provider.enabled).map((provider) => provider.id));
  const extensionRuntime = extensionHostSnapshot();
  const skills = discoverSkills(cwd);
  const agentTools = await agentToolCatalog(false);
  const mcpRuntime = mcpSnapshot();
  const enabledMcp = new Set(agentTools.tools.filter(tool => tool.enabled).map(tool => tool.name));
  const storagePath = databasePath();
  const plugins = listInstalledPlugins();
  const pluginIcons = new Map(plugins.map(plugin => [plugin.id, plugin.iconDataUrl]));

  return {
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      authConfigured: credentialIds.has(provider.id),
      quotaEnabled: provider.quota?.enabled === true,
      mode: 'key',
      icon: provider.icon,
      models: models.filter((model) => model.providerId === provider.id).length,
      mediaModelCount: new Set([...provider.mediaModels.speech, ...provider.mediaModels.image]).size,
      modelsUrl: provider.modelsUrl,
      enabled: provider.enabled,
      builtin: provider.builtin,
    })),
    customModels: models.map((model) => ({
      providerId: model.providerId,
      modelId: model.modelId,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      supportsImages: model.supportsImages,
      reasoning: model.reasoning,
      thinkingLevels: model.thinkingLevels,
      enabled: model.enabled,
      origin: model.source === 'override' ? 'override' : 'configured',
    })),
    mcp: mcpServers.map((server) => ({
      name: server.name,
      transport: server.transport,
      cwd: server.cwd,
      enabled: server.enabled,
      target: server.transport === 'stdio'
        ? [server.command, ...server.args].join(' ')
        : server.url,
      description: server.description,
      exposure: server.exposure,
      toolExposure: server.toolExposure,
      timeoutSeconds: server.timeoutSeconds,
      envKeys: server.envKeys,
      headerKeys: server.headerKeys,
      ownerPluginId: server.ownerPluginId || '',
      origin: server.origin || 'user',
      managed: Boolean(server.managed),
      userOverride: Boolean(server.userOverride),
      oauthConnected: server.transport === 'http'
        && Boolean(oauthStates.get(server.url)?.tokens?.access_token),
      connected: mcpRuntime.servers.find((item) => item.name === server.name)?.connected || false,
      toolCount: mcpRuntime.servers.find((item) => item.name === server.name)?.toolCount || 0,
      error: mcpRuntime.errors.find((item) => item.server === server.name)?.message || '',
      stderr: mcpRuntime.servers.find((item) => item.name === server.name)?.stderr || '',
      tools: mcpRuntime.tools
        .filter((tool) => tool.server === server.name)
        .map((tool) => ({
          name: tool.name,
          originalName: tool.originalName,
          enabled: enabledMcp.has(tool.name),
          description: tool.description,
          exposure: tool.exposure,
        })),
    })),
    plugins,
    skills: skills.skills,
    skillErrors: skills.errors,
    skillSources: db.listSkillSources(),
    extensions: extensionRuntime.extensions.map(extension => {
      const iconDataUrl = pluginIcons.get(extension.ownerPluginId);
      return iconDataUrl ? { ...extension, iconDataUrl } : extension;
    }),
    officialExtensions: officialExtensionsSnapshot().extensions,
    extensionErrors: extensionRuntime.errors,
    extensionApiVersion: extensionRuntime.apiVersion,
    extensionRegistryUrl: getExtensionRegistryUrl(),
    packages: [],
    enabledModels: models
      .filter((model) => model.enabled && enabledProviderIds.has(model.providerId))
      .map((model) => `${model.providerId}/${model.modelId}`),
    agentTools: readAgentToolSelection(db),
    agentToolCatalog: agentTools,
    toolProfiles: getToolProfilesSnapshot(cwd, db),
    permissionProfiles: getPermissionProfilesSnapshot(cwd),
    temporaryCapabilities: await temporaryCapabilitiesSnapshot(),
    harness: getHarnessSettings(cwd),
    storagePath,
    runtimeVersions: {
      durable: durableVersion,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      sqlite: process.versions.sqlite || db.db.prepare('SELECT sqlite_version() AS version').get().version,
      platform: process.platform,
      arch: process.arch,
    },
    databasePath: storagePath,
    attachmentsPath: path.join(attachmentsDirectory(), 'projects'),
    backupsPath: path.join(path.dirname(storagePath), 'backups', 'sqlite'),
    skillsPath: userSkillsDirectory(),
    agentsSkillsPath: sharedUserSkillsDirectory(),
    projectSkillsPath: cwd ? projectSkillsDirectory(cwd) : '',
    projectAgentsSkillsPath: cwd ? sharedProjectSkillsDirectory(cwd) : '',
    extensionsPath: userExtensionsDirectory(),
    projectExtensionsPath: cwd ? projectExtensionsDirectory(cwd) : '',
    model: await modelInfo(cwd),
  };
}

module.exports = { settingsSnapshot };
