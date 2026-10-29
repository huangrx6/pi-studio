'use strict';

const {
  normalizeContent: normalizeUiContent,
  normalizeContentList: normalizeUiContentList,
} = require('../services/studio-extension-ui.cjs');
const {
  isValidSemverRange,
  parseSemver,
} = require('./extension-semver.cjs');
const { normalizeExternalHttpUrl } = require('./external-url.cjs');

const API_VERSION = 1;
const MAX_CONTRIBUTIONS = 256;
const MAX_CONTENT_BLOCKS = 64;
const MAX_DESCRIPTION = 1_200;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const TOOL_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;
const COMMAND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ICON_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,95}$/;
const LICENSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+\-]{0,63}$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTRIBUTION_PATTERN = /^(?:builtin|user|project):[a-z0-9][a-z0-9._-]{1,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;
const EXTENSION_ID_PATTERN = /^(?:builtin|user|project):[a-z0-9][a-z0-9._-]{1,63}$/;
const TIERS = new Set(['core', 'system', 'optional', 'user', 'project']);
const MANIFEST_KEYS = new Set([
  '$schema',
  'format',
  'id',
  'name',
  'version',
  'description',
  'author',
  'publisher',
  'license',
  'repository',
  'homepage',
  'engines',
  'keywords',
  'icon',
  'readme',
  'tier',
  'requires',
  'permissions',
  'providerAccess',
  'runtime',
  'contributes',
]);
const UI_SLOTS = new Set([
  'workspace.sidebar',
  'conversation.header',
  'conversation.detail',
  'conversation.footer',
  'composer.before',
  'settings.panel',
  'panel.side',
  'status.bar',
]);
const PLACEMENTS = new Set(['composer', 'command-menu', 'session', 'workspace']);
const PERMISSIONS = new Set([
  'agent.tools',
  'agent.sections',
  'agent.hooks',
  'agent.tasks',
  'ui.commands',
  'ui.panels',
  'ui.settings',
  'ui.data',
  'provider.credentials',
  'network',
]);
const SETTINGS_PAGES = new Set([
  'general',
  'tools',
  'harness',
  'subagents',
  'permissions',
  'models',
  'usage',
  'mcp',
  'skills',
  'extensions',
  'about',
]);
const COMPACT_FOOTER_KINDS = new Set([
  'text',
  'badge',
  'keyValue',
  'notice',
  'dataView',
]);
const CONTRIBUTION_KEYS = new Set([
  'tools',
  'commands',
  'panels',
  'settings',
  'composer',
  'dataSources',
]);

function safeId(value) {
  return typeof value === 'string'
    && ID_PATTERN.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value);
}

function assertAllowedKeys(value, keys, label) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`${label} 包含未知字段：${key}`);
  }
}

function text(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function optionalText(value, maxLength, pattern) {
  const clean = text(value, maxLength);
  return clean && (!pattern || pattern.test(clean)) ? clean : undefined;
}

function optionalStrictText(value, maxLength, pattern, label) {
  if (value === undefined) return undefined;
  const clean = optionalText(value, maxLength, pattern);
  if (!clean) throw new Error(`${label} 无效`);
  return clean;
}

function optionalHttpsUrl(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 2_000) {
    throw new Error(`${label} 必须是 HTTPS URL`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} 必须是 HTTPS URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(`${label} 必须是 HTTPS URL，且不能包含凭据`);
  }
  return parsed.toString();
}

function normalizePackagePath(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空相对路径`);
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`${label} 不能是绝对路径`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${label} 不能越过扩展目录`);
  }
  return segments.join('/');
}

function normalizeKeywords(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error('keywords 必须是最多 12 项的数组');
  return [...new Set(value.map((item) => {
    if (typeof item !== 'string') throw new Error('keywords 只能包含字符串');
    const keyword = item.trim();
    if (!keyword || keyword.length > 32) throw new Error('keyword 长度必须为 1–32');
    return keyword;
  }))];
}

function normalizeStringList(value, pattern, limit = 64) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('扩展列表字段格式无效');
  if (value.length > limit) throw new Error(`扩展列表最多允许 ${limit} 项`);
  return [...new Set(value.map((item) => {
    const name = text(item, 120);
    if (!name || !pattern.test(name)) throw new Error(`扩展列表包含无效值：${String(item)}`);
    return name;
  }))];
}

function normalizeRequirements(value, scope, ownId) {
  const requirements = normalizeStringList(value, EXTENSION_ID_PATTERN, 64);
  for (const requirement of requirements) {
    if (requirement === ownId) throw new Error(`扩展不能依赖自身：${requirement}`);
    const dependencyScope = requirement.slice(0, requirement.indexOf(':'));
    if (scope === 'builtin' && dependencyScope !== 'builtin') {
      throw new Error(`内置扩展只能依赖其他内置扩展：${requirement}`);
    }
    if (scope === 'user' && dependencyScope === 'project') {
      throw new Error(`用户扩展不能依赖项目扩展：${requirement}`);
    }
  }
  return requirements;
}

function hasPermission(permissions, permission) {
  return permissions.includes(permission);
}

function assertUniqueContributions(items, kind, key = 'id') {
  const seen = new Set();
  for (const item of items) {
    const value = item?.[key];
    if (!value) continue;
    if (seen.has(value)) throw new Error(`${kind} 贡献重复：${value}`);
    seen.add(value);
  }
}

function contributionArray(value, kind, limit = MAX_CONTRIBUTIONS) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${kind} contribution 必须是数组`);
  if (value.length > limit) throw new Error(`${kind} contribution 最多允许 ${limit} 项`);
  for (let index = 0; index < value.length; index += 1) {
    if (!value[index] || typeof value[index] !== 'object' || Array.isArray(value[index])) {
      throw new Error(`${kind}[${index}] 必须是对象`);
    }
  }
  return value;
}

function contributionError(kind, index, message) {
  return new Error(`${kind}[${index}] ${message}`);
}

function assertSharedContributionIds(groups) {
  const owners = new Map();
  for (const { kind, items } of groups) {
    for (const item of items) {
      const id = item?.id;
      if (!id) continue;
      const owner = owners.get(id);
      if (owner) throw new Error(`贡献 ID 跨类型重复：${id}（${owner} 与 ${kind}）`);
      owners.set(id, kind);
    }
  }
}

function dataViewSourceIds(blocks, output = new Set()) {
  if (!Array.isArray(blocks)) return output;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.kind === 'dataView' && typeof block.sourceId === 'string') {
      output.add(block.sourceId);
    }
    if (Array.isArray(block.content)) dataViewSourceIds(block.content, output);
    if (Array.isArray(block.tabs)) {
      for (const tab of block.tabs) dataViewSourceIds(tab?.content, output);
    }
    if (Array.isArray(block.fallback)) dataViewSourceIds(block.fallback, output);
  }
  return output;
}

function assertDataViewSources(blocks, owner, dataSources) {
  const declared = new Set(dataSources.map((source) => (
    `${owner.scope}:${owner.manifestId}/${source.id}`
  )));
  for (const sourceId of dataViewSourceIds(blocks)) {
    if (!declared.has(sourceId)) {
      throw new Error(`dataView 引用了未声明或跨扩展的数据源：${sourceId}`);
    }
  }
}

function contentActions(blocks, output = []) {
  if (!Array.isArray(blocks)) return output;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.kind === 'actions') {
      for (const button of block.buttons || []) {
        if (button?.action) output.push(button.action);
      }
    }
    if (block.kind === 'emptyState' && block.action?.action) {
      output.push(block.action.action);
    }
    if (Array.isArray(block.content)) contentActions(block.content, output);
    if (Array.isArray(block.tabs)) {
      for (const tab of block.tabs) contentActions(tab?.content, output);
    }
    if (Array.isArray(block.fallback)) contentActions(block.fallback, output);
  }
  return output;
}

function assertUiActionPolicies({
  commands,
  panels,
  settings,
  permissions,
  owner,
}) {
  const prefix = `${owner.scope}:${owner.manifestId}/`;
  const panelIds = new Set(panels.map((panel) => `${prefix}${panel.id}`));
  const commandById = new Map(commands.map((command) => [
    `${prefix}${command.id}`,
    command,
  ]));
  const validate = (action) => {
    if (action?.kind === 'openPanel') {
      if (!hasPermission(permissions, 'ui.panels')) {
        throw new Error('openPanel action 需要 ui.panels 权限');
      }
      if (!panelIds.has(action.panelId)) {
        throw new Error(`openPanel action 引用了未声明的 panel：${action.panelId}`);
      }
    }
    if (action?.kind === 'runCommand') {
      if (!hasPermission(permissions, 'ui.commands')) {
        throw new Error('runCommand action 需要 ui.commands 权限');
      }
      const command = commandById.get(action.commandId);
      if (!command) {
        throw new Error(`runCommand action 引用了未声明的 command：${action.commandId}`);
      }
      if (command.action) {
        throw new Error(`runCommand action 只能调用带 runtime handler 的命令：${action.commandId}`);
      }
    }
  };
  for (const command of commands) validate(command.action);
  for (const panel of panels) {
    for (const action of contentActions(panel.content)) validate(action);
  }
  for (const setting of settings) {
    for (const action of contentActions(setting.content)) validate(action);
  }
}

function contributionReference(value, owner) {
  const clean = text(value, 220);
  if (!clean || !owner?.scope || !owner?.manifestId) return undefined;
  const prefix = `${owner.scope}:${owner.manifestId}/`;
  if (CONTRIBUTION_PATTERN.test(clean)) {
    return clean.startsWith(prefix) ? clean : undefined;
  }
  return COMMAND_PATTERN.test(clean) ? `${prefix}${clean}` : undefined;
}

function normalizeUiAction(raw, owner) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const kind = text(raw.kind, 32);
  if (kind === 'openSettings') {
    assertAllowedKeys(raw, new Set(['kind', 'panel']), 'UI action');
    if (raw.panel === undefined) return { kind };
    const panel = text(raw.panel, 32);
    if (!SETTINGS_PAGES.has(panel)) {
      throw new Error(`openSettings.panel 无效：${panel || '(empty)'}`);
    }
    return { kind, panel };
  }
  if (kind === 'openPanel') {
    assertAllowedKeys(raw, new Set(['kind', 'panelId']), 'UI action');
    const panelId = contributionReference(raw.panelId, owner);
    return panelId ? { kind, panelId } : undefined;
  }
  if (kind === 'sendPrompt') {
    assertAllowedKeys(raw, new Set(['kind', 'text', 'submit']), 'UI action');
    const prompt = text(raw.text, 100_000);
    return prompt ? { kind, text: prompt, submit: raw.submit === true } : undefined;
  }
  if (kind === 'copyText') {
    assertAllowedKeys(raw, new Set(['kind', 'text']), 'UI action');
    const value = text(raw.text, 100_000);
    return value ? { kind, text: value } : undefined;
  }
  if (kind === 'openUrl') {
    assertAllowedKeys(raw, new Set(['kind', 'url']), 'UI action');
    return {
      kind,
      url: normalizeExternalHttpUrl(raw.url),
    };
  }
  if (kind === 'runCommand') {
    assertAllowedKeys(raw, new Set(['kind', 'commandId']), 'UI action');
    const commandId = contributionReference(raw.commandId, owner);
    return commandId ? { kind, commandId } : undefined;
  }
  return undefined;
}

function normalizeContent(raw, owner, index = 0) {
  return normalizeUiContent(raw, owner, normalizeUiAction, index);
}

function normalizeContentList(value, owner) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('UI content 必须是数组');
  if (value.length > MAX_CONTENT_BLOCKS) {
    throw new Error(`UI content 最多允许 ${MAX_CONTENT_BLOCKS} 项`);
  }
  return normalizeUiContentList(value, owner, normalizeUiAction, MAX_CONTENT_BLOCKS);
}

function normalizeManifest(raw, source, scope) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('manifest 必须是对象');
  for (const key of Object.keys(raw)) {
    if (!MANIFEST_KEYS.has(key)) throw new Error(`manifest 包含未知字段：${key}`);
  }
  if (Number(raw.format) !== API_VERSION) throw new Error(`只支持 format ${API_VERSION}`);
  if (!safeId(raw.id)) throw new Error('扩展 id 需要 2–64 个小写字母、数字、点、横线或下划线');
  const name = text(raw.name, 120);
  if (!name) throw new Error('扩展 name 不能为空');
  let version;
  try {
    version = parseSemver(raw.version).raw;
  } catch (error) {
    throw new Error(`扩展 version 必须是语义化版本：${error instanceof Error ? error.message : String(error)}`);
  }
  const description = text(raw.description, MAX_DESCRIPTION);
  const author = text(raw.author, 160);
  const publisher = optionalStrictText(
    raw.publisher,
    80,
    /^[^\0-\x1f\x7f]+$/,
    'publisher',
  ) || author;
  const license = optionalStrictText(raw.license, 64, LICENSE_PATTERN, 'license');
  const repository = optionalHttpsUrl(raw.repository, 'repository');
  const homepage = optionalHttpsUrl(raw.homepage, 'homepage');
  const engines = raw.engines === undefined
    ? {}
    : raw.engines && typeof raw.engines === 'object' && !Array.isArray(raw.engines)
      ? raw.engines
      : (() => { throw new Error('engines 必须是对象'); })();
  for (const key of Object.keys(engines)) {
    if (key !== 'piStudio') throw new Error(`engines 包含未知字段：${key}`);
  }
  const piStudioRange = engines.piStudio === undefined ? undefined : text(engines.piStudio, 120);
  if (piStudioRange !== undefined && !isValidSemverRange(piStudioRange)) {
    throw new Error(`engines.piStudio 版本范围无效：${piStudioRange}`);
  }
  const keywords = normalizeKeywords(raw.keywords);
  const icon = normalizePackagePath(raw.icon, 'icon');
  const readme = normalizePackagePath(raw.readme, 'readme');
  const owner = { manifestId: raw.id, scope };
  const tier = scope === 'builtin' ? text(raw.tier, 16) : scope;
  if (scope !== 'builtin' && raw.tier !== undefined) {
    throw new Error('只有内置扩展可以声明 tier');
  }
  if (!TIERS.has(tier) || (
    scope === 'builtin'
    && tier !== 'core'
    && tier !== 'system'
    && tier !== 'optional'
  )) {
    throw new Error(`扩展 tier 无效：${tier || '(empty)'}`);
  }
  const requirements = normalizeRequirements(
    raw.requires,
    scope,
    `${scope}:${raw.id}`,
  );
  const contributes = raw.contributes
    && typeof raw.contributes === 'object'
    && !Array.isArray(raw.contributes)
    ? raw.contributes
    : {};
  for (const key of Object.keys(contributes)) {
    if (!CONTRIBUTION_KEYS.has(key)) throw new Error(`未知 contribution 类型：${key}`);
  }
  const permissions = normalizeStringList(raw.permissions, /^[a-z]+(?:\.[a-z]+)*$/);
  for (const permission of permissions) {
    if (!PERMISSIONS.has(permission)) throw new Error(`未知权限：${permission}`);
  }
  const providerAccess = normalizeStringList(
    raw.providerAccess,
    PROVIDER_ID_PATTERN,
    64,
  );
  if (hasPermission(permissions, 'provider.credentials') && providerAccess.length === 0) {
    throw new Error('provider.credentials 权限必须通过 providerAccess 精确列出允许读取的来源');
  }
  if (providerAccess.length > 0 && !hasPermission(permissions, 'provider.credentials')) {
    throw new Error('providerAccess 需要 provider.credentials 权限');
  }
  const runtime = raw.runtime === undefined
    ? {}
    : raw.runtime && typeof raw.runtime === 'object' && !Array.isArray(raw.runtime)
      ? raw.runtime
      : (() => { throw new Error('runtime 必须是对象'); })();
  for (const key of Object.keys(runtime)) {
    if (key !== 'durableEntry') throw new Error(`runtime 包含未知字段：${key}`);
  }
  const durableEntry = text(runtime.durableEntry, 512);
  const requestedDataSources = contributionArray(contributes.dataSources, 'dataSources');
  if (durableEntry && !durableEntry.endsWith('.mjs') && !durableEntry.endsWith('.js')) {
    throw new Error('runtime.durableEntry 必须是 .mjs 或 .js 文件');
  }
  if (hasPermission(permissions, 'provider.credentials') && !durableEntry) {
    throw new Error('provider.credentials 权限必须提供 runtime.durableEntry，并通过 activate(context) 获取只读能力');
  }
  if (requestedDataSources.length && !hasPermission(permissions, 'ui.data')) {
    throw new Error('dataSources contribution 需要 ui.data 权限');
  }
  const hasAgentPermission = permissions.some((permission) => permission.startsWith('agent.'));
  if (
    durableEntry
    && !hasAgentPermission
    && !hasPermission(permissions, 'provider.credentials')
    && !hasPermission(permissions, 'ui.commands')
    && !hasPermission(permissions, 'ui.data')
  ) {
    throw new Error('包含 durableEntry 的扩展必须声明 agent.*、provider.credentials、ui.commands 或 ui.data 权限');
  }
  if (!durableEntry && hasAgentPermission && scope !== 'builtin') {
    throw new Error('声明 agent.* 权限的扩展必须提供 runtime.durableEntry');
  }
  const requestedTools = contributionArray(contributes.tools, 'tools');
  const requestedCommands = contributionArray(contributes.commands, 'commands');
  const requestedPanels = contributionArray(contributes.panels, 'panels');
  const requestedSettings = contributionArray(contributes.settings, 'settings');
  const requestedComposer = contributionArray(contributes.composer, 'composer', 16);
  if (requestedTools.length && !hasPermission(permissions, 'agent.tools')) {
    throw new Error('tools contribution 需要 agent.tools 权限');
  }
  if ((requestedCommands.length || requestedComposer.length) && !hasPermission(permissions, 'ui.commands')) {
    throw new Error('commands/composer contribution 需要 ui.commands 权限');
  }
  if (requestedPanels.length && !hasPermission(permissions, 'ui.panels')) {
    throw new Error('panels contribution 需要 ui.panels 权限');
  }
  if (requestedSettings.length && !hasPermission(permissions, 'ui.settings')) {
    throw new Error('settings contribution 需要 ui.settings 权限');
  }
  if (hasPermission(permissions, 'ui.data') && requestedDataSources.length === 0) {
    throw new Error('声明 ui.data 权限时必须提供 contributes.dataSources');
  }
  if (requestedDataSources.length && !durableEntry && scope !== 'builtin') {
    throw new Error('dataSources contribution 需要 runtime.durableEntry');
  }
  if (!durableEntry && requestedCommands.some((command) => command.action === undefined)) {
    throw new Error('没有 action 的 commands contribution 需要 runtime.durableEntry 提供命令处理器');
  }

  const tools = requestedTools.map((item, index) => {
    assertAllowedKeys(item, new Set(['name', 'description']), `tools[${index}]`);
    const name = text(item?.name, 120);
    if (!name || !TOOL_PATTERN.test(name)) {
      throw contributionError('tools', index, 'name 只能包含字母、数字、点、横线、下划线或冒号');
    }
    return { name, description: text(item?.description, 600) };
  });
  const commands = requestedCommands.map((item, index) => {
    assertAllowedKeys(
      item,
      new Set(['id', 'title', 'description', 'placement', 'argumentHint', 'icon', 'action']),
      `commands[${index}]`,
    );
    const id = text(item?.id, 64);
    const title = text(item?.title, 120);
    const placement = text(item?.placement, 32) || 'command-menu';
    if (!COMMAND_PATTERN.test(id)) throw contributionError('commands', index, 'id 无效');
    if (!title) throw contributionError('commands', index, 'title 不能为空');
    if (!PLACEMENTS.has(placement)) throw contributionError('commands', index, `未知 placement：${placement}`);
    const action = normalizeUiAction(item?.action, owner);
    if (item.action !== undefined && !action) {
      throw contributionError('commands', index, 'action 无效');
    }
    const argumentHint = text(item?.argumentHint, 120);
    const icon = optionalStrictText(item.icon, 64, ICON_PATTERN, `commands[${index}].icon`);
    return {
      id,
      title,
      description: text(item?.description, MAX_DESCRIPTION),
      placement,
      ...(argumentHint ? { argumentHint } : {}),
      ...(icon ? { icon } : {}),
      ...(action ? { action } : {}),
    };
  });
  const panels = requestedPanels.map((item, index) => {
    assertAllowedKeys(
      item,
      new Set(['id', 'title', 'description', 'slot', 'icon', 'size', 'priority', 'content']),
      `panels[${index}]`,
    );
    const id = text(item?.id, 64);
    const title = text(item?.title, 120);
    const slot = text(item?.slot, 64);
    if (!COMMAND_PATTERN.test(id)) throw contributionError('panels', index, 'id 无效');
    if (!title) throw contributionError('panels', index, 'title 不能为空');
    if (!UI_SLOTS.has(slot)) throw contributionError('panels', index, `未知 slot：${slot || '(empty)'}`);
    const description = text(item?.description, MAX_DESCRIPTION);
    const icon = optionalStrictText(item.icon, 64, ICON_PATTERN, `panels[${index}].icon`);
    if (item.size !== undefined && item.size !== 'compact' && item.size !== 'regular') {
      throw contributionError('panels', index, `size 无效：${String(item.size)}`);
    }
    if (item.priority !== undefined && !Number.isFinite(item.priority)) {
      throw contributionError('panels', index, 'priority 必须是数字');
    }
    const content = normalizeContentList(item?.content, owner);
    if (slot === 'conversation.footer') {
      if (content.length === 0 || content.length > 2) {
        throw contributionError(
          'panels',
          index,
          'conversation.footer 必须声明一至两个单行摘要 block',
        );
      }
      const unsupported = content.find((block) => !COMPACT_FOOTER_KINDS.has(block.kind));
      if (unsupported) {
        throw contributionError(
          'panels',
          index,
          `conversation.footer 不支持 ${unsupported.kind}；完整内容请使用 conversation.detail`,
        );
      }
    }
    return {
      id,
      title,
      description,
      slot,
      size: item.size === 'compact' ? 'compact' : 'regular',
      priority: Number.isFinite(item?.priority)
        ? Math.max(-1_000, Math.min(1_000, Math.trunc(item.priority)))
        : 0,
      content,
      ...(icon ? { icon } : {}),
    };
  });
  const settings = requestedSettings.map((item, index) => {
    assertAllowedKeys(
      item,
      new Set(['id', 'title', 'description', 'content']),
      `settings[${index}]`,
    );
    const id = text(item?.id, 64);
    const title = text(item?.title, 120);
    if (!COMMAND_PATTERN.test(id)) throw contributionError('settings', index, 'id 无效');
    if (!title) throw contributionError('settings', index, 'title 不能为空');
    return {
      id,
      title,
      description: text(item?.description, MAX_DESCRIPTION),
      content: normalizeContentList(item?.content, owner),
    };
  });
  const composer = requestedComposer.map((item, index) => {
    assertAllowedKeys(
      item,
      new Set(['id', 'title', 'description', 'action', 'argumentHint', 'icon']),
      `composer[${index}]`,
    );
    const id = text(item?.id, 64);
    const title = text(item?.title, 80);
    const action = text(item?.action, 64);
    const argumentHint = text(item?.argumentHint, 120);
    const icon = optionalStrictText(item.icon, 64, ICON_PATTERN, `composer[${index}].icon`);
    if (!COMMAND_PATTERN.test(id)) throw contributionError('composer', index, 'id 无效');
    if (!title) throw contributionError('composer', index, 'title 不能为空');
    if (!COMMAND_PATTERN.test(action)) {
      throw contributionError('composer', index, 'action 必须引用同一扩展的命令 ID');
    }
    return {
      id,
      title,
      action,
      description: text(item?.description, MAX_DESCRIPTION),
      ...(argumentHint ? { argumentHint } : {}),
      ...(icon ? { icon } : {}),
    };
  });
  const dataSources = requestedDataSources.map((item, index) => {
    assertAllowedKeys(
      item,
      new Set(['id', 'title', 'description']),
      `dataSources[${index}]`,
    );
    const id = text(item?.id, 64);
    const title = text(item?.title, 120);
    if (!COMMAND_PATTERN.test(id)) throw contributionError('dataSources', index, 'id 无效');
    if (!title) throw contributionError('dataSources', index, 'title 不能为空');
    return {
      id,
      title,
      description: text(item?.description, MAX_DESCRIPTION),
    };
  });
  assertUniqueContributions(tools, 'tools', 'name');
  assertUniqueContributions(commands, 'commands');
  assertUniqueContributions(panels, 'panels');
  assertUniqueContributions(settings, 'settings');
  assertUniqueContributions(composer, 'composer');
  assertUniqueContributions(dataSources, 'dataSources');
  assertSharedContributionIds([
    { kind: 'commands', items: commands },
    { kind: 'panels', items: panels },
    { kind: 'settings', items: settings },
    { kind: 'composer', items: composer },
    { kind: 'dataSources', items: dataSources },
  ]);
  const commandIds = new Set(commands.map((command) => command.id));
  for (const item of composer) {
    if (!commandIds.has(item.action)) {
      throw new Error(`composer ${item.id} 引用了未声明的 command：${item.action}`);
    }
  }
  for (const panel of panels) {
    assertDataViewSources(panel.content, owner, dataSources);
  }
  for (const setting of settings) {
    assertDataViewSources(setting.content, owner, dataSources);
  }
  assertUiActionPolicies({
    commands,
    panels,
    settings,
    permissions,
    owner,
  });
  return {
    format: API_VERSION,
    id: raw.id,
    name,
    version,
    description,
    author,
    ...(publisher ? { publisher } : {}),
    ...(license ? { license } : {}),
    ...(repository ? { repository } : {}),
    ...(homepage ? { homepage } : {}),
    ...(piStudioRange ? { engines: { piStudio: piStudioRange } } : {}),
    keywords,
    ...(icon ? { icon } : {}),
    ...(readme ? { readme } : {}),
    scope,
    source,
    tier,
    requires: requirements,
    permissions,
    providerAccess,
    runtime: { durableEntry },
    contributes: { tools, commands, panels, settings, composer, dataSources },
  };
}

module.exports = {
  API_VERSION,
  normalizeContent,
  normalizeManifest,
};
