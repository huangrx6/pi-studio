/**
 * Read-only settings projection for the renderer.
 *
 * Every value comes from Studio SQLite or Studio-owned directories. No Pi
 * CLI credential, model, MCP, skill, or extension file is inspected.
 */

const {
  databasePath,
  getStudioDatabase,
} = require('../core/studio-db.cjs');
const {
  getExtensionRegistryUrl,
  getHarnessSettings,
} = require('../core/app-settings.cjs');
const { DEFAULT_CWD } = require('../core/state.cjs');
const { modelInfo } = require('./models.cjs');
const {
  discoverSkills,
  projectSkillsDirectory,
  sharedProjectSkillsDirectory,
  sharedUserSkillsDirectory,
  userSkillsDirectory,
} = require('./studio-skills.cjs');
const {
  extensionHostSnapshot,
  officialExtensionsSnapshot,
  projectExtensionsDirectory,
  userExtensionsDirectory,
} = require('./studio-extensions.cjs');
const {
  agentToolCatalog,
  readAgentToolSelection,
} = require('./tool-selection.cjs');
const { mcpSnapshot } = require('./mcp-runtime.cjs');

async function settingsSnapshot(cwd = DEFAULT_CWD) {
  const db = getStudioDatabase();
  const providers = db.listProviders();
  const models = db.listModels();
  const credentialIds = new Set(db.listCredentials().map((item) => item.providerId));
  const enabledProviderIds = new Set(providers.filter((provider) => provider.enabled).map((provider) => provider.id));
  const extensionRuntime = extensionHostSnapshot();
  const skills = discoverSkills(cwd);
  const agentTools = await agentToolCatalog(false);
  const mcpRuntime = mcpSnapshot();
  const storagePath = databasePath();

  return {
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      authConfigured: credentialIds.has(provider.id),
      mode: 'key',
      icon: provider.icon,
      models: models.filter((model) => model.providerId === provider.id).length,
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
    mcp: db.listMcpServers().map((server) => ({
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
      connected: mcpRuntime.servers.find((item) => item.name === server.name)?.connected || false,
      toolCount: mcpRuntime.servers.find((item) => item.name === server.name)?.toolCount || 0,
      error: mcpRuntime.errors.find((item) => item.server === server.name)?.message || '',
      stderr: mcpRuntime.servers.find((item) => item.name === server.name)?.stderr || '',
    })),
    skills: skills.skills,
    skillErrors: skills.errors,
    extensions: extensionRuntime.extensions,
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
    harness: getHarnessSettings(cwd),
    storagePath,
    agentToolsPath: `${storagePath} · studio.agent.tools`,
    databasePath: storagePath,
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
