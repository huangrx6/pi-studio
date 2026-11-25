const { discoverSkills, readSkillBlock, skillReferenceId } = require('../capabilities/skills/index.cjs');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const { mcpSnapshot } = require('../integrations/mcp/runtime.cjs');
const { readPluginIcon } = require('../services/plugin-icon.cjs');
const { runtimeExtensionName } = require('../services/studio-extensions.cjs');

// Another chip can contain punctuation in its filename or its role label.
const MENTION = /(?<![A-Za-z0-9_])(?:@"(?:\\.|[^"\\])*"|[@#]\[agent:[a-f0-9-]{36}\|[a-z0-9-]+\|[^\]\r\n|]+\]|\$\[(skill|mcp|mcp-server|plugin):([^|\]\s]+)\|([^|\]\s]+)\])/gu;
const LABEL = { skill: '技能', mcp: 'MCP 方法', 'mcp-server': 'MCP 服务', plugin: '插件' };

function readableCapabilityReferences(text) {
  if (!text.includes('$[')) return text;
  return text.replace(MENTION, (token, kind, _id, label) => {
    if (!kind) return token;
    try { return '$' + decodeURIComponent(label); } catch { return token; }
  });
}

function capabilityToken(option) {
  const label = option.type === 'mcp' ? option.server + '/' + option.name : option.name;
  return `$[${option.type}:${encodeURIComponent(option.id)}|${encodeURIComponent(label)}]`;
}

function toolReference(tool) {
  return { tool: tool.name, ...(tool.deferred && { discoverWith: 'tool_search' }) };
}

function pluginCapability({ plugin, skills, methods, tools }, offered, includeIcons) {
  const canRead = offered.has('read') || offered.has('bash');
  const inlineSkills = skills.length === 1 || !canRead ? skills : [];
  const cli = offered.has('bash') ? (plugin.provides?.cli || [])
    .filter(command => !command.platform?.length || command.platform.includes(`${process.platform}-${process.arch}`))
    .map(command => ({ name: command.name, command: command.absoluteBin || command.command, description: command.description })) : [];
  if (!skills.length && !methods.length && !tools.length && !cli.length) return undefined;
  const iconDataUrl = includeIcons ? readPluginIcon(plugin.installPath, plugin.icon) : '';
  return {
    option: {
      type: 'plugin', id: plugin.id, name: plugin.name, description: plugin.description,
      source: plugin.publisher, ...(iconDataUrl && { iconDataUrl }),
    },
    related: inlineSkills.map(({ row }) => row),
    context: () => [
      'The user selected this installed Pi Studio plugin. Use the resources relevant to their request.',
      JSON.stringify({
        plugin: plugin.name,
        skills: skills.map(({ row, skill }) => ({
          name: row.option.name, description: row.option.description,
          ...(inlineSkills.length === 0 && { file: skill.path }),
        })),
        mcp: methods,
        tools,
        cli,
      }),
      ...(skills.length > inlineSkills.length ? ['Load the relevant skill file before following its instructions.'] : []),
      ...(cli.length ? ['Check that a CLI command is available before using it.'] : []),
    ].join('\n'),
  };
}

// Build options from the tools actually offered to the conversation and the
// available skills in its workspace. Resource paths stay in the main process.
function composerCapabilityCatalog(cwd, selection, { skills = discoverSkills(cwd).skills, includeIcons = false } = {}) {
  const db = getStudioDatabase();
  const plugins = new Map(db.listPlugins().map(plugin => [plugin.id, { plugin, skills: [], methods: [], tools: [] }]));
  const offered = new Set(selection.tools
    .filter(tool => !Array.isArray(tool.callers) || tool.callers.includes('model'))
    .map(tool => tool.name));
  const rows = [];
  for (const skill of skills) {
    if (!skill.available) continue;
    const resources = plugins.get(skill.ownerPluginId);
    const source = skill.ownerPluginId ? '插件 · ' + (resources?.plugin.name || skill.ownerPluginId) : skill.scope === 'project' ? '当前工作区' : '个人技能';
    const row = {
      option: { type: 'skill', id: skillReferenceId(skill), name: skill.name, description: skill.description, source },
      context: () => readSkillBlock(skill),
    };
    rows.push(row);
    resources?.skills.push({ row, skill });
  }
  const mcp = mcpSnapshot();
  const serverDescriptions = new Map(mcp.servers.filter(server => server.connected)
    .map(server => [server.name, server.description]));
  const serverGroups = new Map();
  for (const method of mcp.tools) {
    if (!offered.has(method.name) || method.exposure === 'hidden' || method.enabledOverride === false
      || !serverDescriptions.has(method.server)) continue;
    const resources = plugins.get(method.ownerPluginId);
    const source = method.ownerPluginId ? '插件 · ' + (resources?.plugin.name || method.ownerPluginId) : '个人配置';
    const serverId = JSON.stringify([method.ownerPluginId || '', method.server]);
    const id = JSON.stringify([method.ownerPluginId || '', method.server, method.originalName]);
    const serverText = serverDescriptions.get(method.server) || '';
    const useServerText = /\p{Script=Han}/u.test(serverText) && !/\p{Script=Han}/u.test(method.description);
    const reference = {
      server: method.server, method: method.originalName,
      ...toolReference({ name: method.name, deferred: method.exposure === 'deferred' }),
    };
    let group = serverGroups.get(serverId);
    if (!group) {
      group = { name: method.server, source, description: serverText, tools: [], deferredTools: [] };
      serverGroups.set(serverId, group);
    }
    (method.exposure === 'deferred' ? group.deferredTools : group.tools).push(method.name);
    rows.push({
      option: {
        type: 'mcp', id, name: method.originalName, server: method.server, serverId, source,
        description: useServerText ? '服务说明 · ' + serverText : method.description,
        ...(useServerText && { originalDescription: method.description }),
      },
      context: () => 'The user referenced this available MCP method. ' + JSON.stringify(reference),
    });
    resources?.methods.push(reference);
  }
  for (const [id, { name, description, source, tools, deferredTools }] of serverGroups) {
    rows.push({
      option: { type: 'mcp-server', id, name, server: name, source, description, methodCount: tools.length + deferredTools.length },
      context: () => 'The user referenced this MCP service. Choose the methods relevant to their request. ' + JSON.stringify({
        server: name, tools, ...(deferredTools.length && { deferredTools, discoverWith: 'tool_search' }),
      }),
    });
  }
  if (plugins.size) {
    const extensionOwners = new Map(db.listExtensions()
      .filter(row => plugins.has(row.ownerPluginId))
      .map(row => [runtimeExtensionName(row.id), row.ownerPluginId]));
    for (const { extension, tool } of selection.toolEntries || []) {
      if (!offered.has(tool.name)) continue;
      plugins.get(extensionOwners.get(extension.name))?.tools.push(toolReference(tool));
    }
    for (const resources of plugins.values()) {
      if (!resources.plugin.enabled) continue;
      const row = pluginCapability(resources, offered, includeIcons);
      if (row) rows.push(row);
    }
  }
  return rows;
}

function resolveCapabilityReferences(text, loadCatalog) {
  let catalog;
  const blocks = new Map();
  const addContext = row => {
    const key = row.option.type + ':' + row.option.id;
    if (!blocks.has(key)) blocks.set(key, row.context());
  };
  const display = text.includes('$[') ? text.replace(MENTION, (token, kind, encodedId) => {
    if (!kind) return token;
    let id;
    try { id = decodeURIComponent(encodedId); } catch { throw new Error('能力引用格式无效，请用 $ 重新选择。'); }
    catalog ??= new Map(loadCatalog().map(row => [row.option.type + ':' + row.option.id, row]));
    const key = kind + ':' + id;
    const row = catalog.get(key);
    if (!row) throw new Error(`引用的${LABEL[kind]}当前不可用，请移除引用或用 $ 重新选择。`);
    addContext(row);
    for (const related of row.related || []) addContext(related);
    return capabilityToken(row.option);
  }) : text;
  return { display, context: [...blocks.values()].join('\n\n') };
}

module.exports = { composerCapabilityCatalog, readableCapabilityReferences, resolveCapabilityReferences };
