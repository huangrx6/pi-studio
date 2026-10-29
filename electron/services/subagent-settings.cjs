/**
 * pi-subagents 设置与角色目录。
 *
 * 配置由扩展自己读取 Pi 的 settings.json：
 *  - 用户级在 agentDir/settings.json
 *  - 项目级在最近项目根目录的 .pi/settings.json
 *
 * Studio 只编辑 `subagents.defaultModel`、`defaultThinking`、`maxThinking`
 * 与 `agentOverrides.<role>.{model,thinking}`，其它字段原样保留。
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_CWD,
  agentDir,
  getModelRef,
  getRuntime,
  modelOptionsModule,
  readJson,
  settingsFile,
  writeConfig,
} = require('../core/state.cjs');

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PROJECT_MARKERS = ['.pi', '.agents'];
const RESERVED_AGENT_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

function walk(root, depth = 0, result = []) {
  if (depth > 5 || !fs.existsSync(root)) return result;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return result; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1, result);
    else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.endsWith('.chain.md')) result.push(full);
  }
  return result;
}

/** Frontmatter only needs the scalar fields used by Studio's compact role list. */
function parseAgentFile(file, source) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return undefined; }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
    if (!field) continue;
    fields[field[1]] = field[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const name = fields.name || path.basename(file, path.extname(file));
  return {
    name,
    description: fields.description || '',
    aliases: fields.aliases ? fields.aliases.split(',').map((item) => item.trim()).filter(Boolean) : [],
    source,
    path: file,
    model: fields.model || '',
    thinking: fields.thinking || '',
  };
}

function findProjectRoot(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return undefined;
  let current = path.resolve(cwd);
  const home = path.resolve(require('node:os').homedir());
  while (current !== home && current !== path.dirname(current)) {
    if (PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(current, marker)))) return current;
    current = path.dirname(current);
  }
  return undefined;
}

/**
 * Pi uses the nearest `.pi` / `.agents` root. When a workspace has neither yet,
 * Studio still needs a predictable place for the first project-level setting:
 * create `.pi` in that workspace. Existing parent roots are never shadowed.
 */
function resolvedProjectRoot(cwd) {
  const found = findProjectRoot(cwd);
  if (found) return found;
  return typeof cwd === 'string' && path.isAbsolute(cwd)
    ? path.resolve(cwd)
    : path.resolve(DEFAULT_CWD);
}

function projectSettingsPath(cwd) {
  return path.join(resolvedProjectRoot(cwd), '.pi', 'settings.json');
}

function packageRoot() {
  return path.join(agentDir(), 'npm', 'node_modules', 'pi-subagents');
}

function extensionRoot() {
  return path.join(agentDir(), 'extensions', 'subagent');
}

function piSubagentsInstalled() {
  return fs.existsSync(path.join(extensionRoot(), 'package.json'))
    || fs.existsSync(path.join(packageRoot(), 'package.json'));
}

/**
 * Discover bundled, user, and project agents. Later sources overwrite an earlier
 * runtime name, matching pi-subagents' project > user > package > builtin order.
 */
function discoverAgents(cwd) {
  const found = new Map();
  const roots = [
    ['builtin', path.join(extensionRoot(), 'agents')],
    ['package', path.join(packageRoot(), 'agents')],
    ['user', path.join(agentDir(), 'agents')],
  ];
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot) {
    roots.push(['project', path.join(projectRoot, '.pi', 'agents')]);
    roots.push(['project', path.join(projectRoot, '.agents')]);
  }
  for (const [source, root] of roots) {
    for (const file of walk(root)) {
      const agent = parseAgentFile(file, source);
      if (agent) found.set(agent.name, agent);
    }
  }
  return [...found.values()].sort((left, right) => {
    const priority = { builtin: 0, package: 1, user: 2, project: 3 };
    return priority[left.source] - priority[right.source] || left.name.localeCompare(right.name);
  });
}

function normalizeThinking(value) {
  return THINKING_LEVELS.includes(value) ? value : '';
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const overrides = {};
  for (const [name, value] of Object.entries(source.agentOverrides || {})) {
    if (RESERVED_AGENT_NAMES.has(name) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = {};
    if (typeof value.model === 'string' && value.model.trim()) row.model = value.model.trim();
    if (value.thinking === false) row.thinking = 'off';
    else if (normalizeThinking(value.thinking)) row.thinking = value.thinking;
    if (!row.model && !row.thinking) continue;
    overrides[name] = row;
  }
  return {
    defaultModel: typeof source.defaultModel === 'string' ? source.defaultModel.trim() : '',
    defaultProvider: typeof source.defaultProvider === 'string' ? source.defaultProvider.trim() : '',
    defaultThinking: normalizeThinking(source.defaultThinking),
    maxThinking: normalizeThinking(source.maxThinking),
    agentOverrides: overrides,
  };
}

async function modelCatalog() {
  const runtime = await getRuntime();
  return runtime.getModels()
    .filter((model) => runtime.hasConfiguredAuth(model.provider) || `${model.provider}/${model.id}` === getModelRef())
    .map((model) => {
      const options = modelOptionsModule().reasoningOptions(model);
      return {
        modelRef: `${model.provider}/${model.id}`,
        provider: model.provider,
        label: model.name || model.id,
        reasoning: Boolean(model.reasoning),
        thinkingLevels: options.thinkingLevels.filter((level) => level !== 'default'),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

async function subagentSettings(cwd = DEFAULT_CWD) {
  const userSettings = readJson(settingsFile(), {}) || {};
  const projectPath = projectSettingsPath(cwd);
  const projectSettings = readJson(projectPath, {}) || {};
  return {
    installed: piSubagentsInstalled(),
    userPath: settingsFile(),
    projectPath,
    projectRoot: resolvedProjectRoot(cwd),
    user: normalizeConfig(userSettings.subagents),
    project: normalizeConfig(projectSettings.subagents),
    agents: discoverAgents(cwd),
    models: await modelCatalog(),
    currentModel: getModelRef(),
    thinkingLevels: THINKING_LEVELS,
    projectRootExists: Boolean(findProjectRoot(cwd)),
  };
}

function setOrDelete(target, key, value) {
  if (value === undefined || value === null || value === '') delete target[key];
  else target[key] = value;
}

/**
 * Merge only Studio-owned pi-subagents fields. Agent overrides keep tools,
 * skills, prompts, extensions, and any future fields owned by the extension.
 */
function mergeSubagentSettings(settingsDocument, input) {
  const document = settingsDocument && typeof settingsDocument === 'object' && !Array.isArray(settingsDocument)
    ? { ...settingsDocument }
    : {};
  const subagents = document.subagents && typeof document.subagents === 'object' && !Array.isArray(document.subagents)
    ? { ...document.subagents }
    : {};
  const next = input && typeof input === 'object' ? input : {};
  setOrDelete(subagents, 'defaultModel', typeof next.defaultModel === 'string' ? next.defaultModel.trim() : '');
  setOrDelete(subagents, 'defaultProvider', typeof next.defaultProvider === 'string' ? next.defaultProvider.trim() : '');
  setOrDelete(subagents, 'defaultThinking', normalizeThinking(next.defaultThinking));
  setOrDelete(subagents, 'maxThinking', normalizeThinking(next.maxThinking));

  const oldOverrides = subagents.agentOverrides && typeof subagents.agentOverrides === 'object' && !Array.isArray(subagents.agentOverrides)
    ? { ...subagents.agentOverrides }
    : {};
  for (const [name, value] of Object.entries(next.agentOverrides || {})) {
    if (!name || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (RESERVED_AGENT_NAMES.has(name)) throw new Error('子 Agent 名称无效');
    const row = oldOverrides[name] && typeof oldOverrides[name] === 'object' && !Array.isArray(oldOverrides[name])
      ? { ...oldOverrides[name] }
      : {};
    const model = typeof value.model === 'string' ? value.model.trim() : '';
    setOrDelete(row, 'model', model);
    const thinking = normalizeThinking(value.thinking);
    // pi-subagents treats `false` as an explicit per-role opt-out. Persisting
    // the string "off" there would change the meaning from "disable thinking"
    // to a normal thinking-level request.
    setOrDelete(row, 'thinking', thinking === 'off' ? false : thinking);
    if (Object.keys(row).length > 0) oldOverrides[name] = row;
    else delete oldOverrides[name];
  }
  if (Object.keys(oldOverrides).length > 0) subagents.agentOverrides = oldOverrides;
  else delete subagents.agentOverrides;

  if (Object.keys(subagents).length > 0) document.subagents = subagents;
  else delete document.subagents;
  return document;
}

function saveSubagentSettings(cwd, scope, input) {
  if (!['user', 'project'].includes(scope)) throw new Error('设置范围无效');
  if (scope === 'project' && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) throw new Error('当前工作区无效');
  const file = scope === 'project' ? projectSettingsPath(cwd) : settingsFile();
  const next = mergeSubagentSettings(readJson(file, {}) || {}, input);
  writeConfig(file, next, scope === 'user' ? 0o600 : undefined);
  return subagentSettings(cwd);
}

module.exports = {
  THINKING_LEVELS,
  discoverAgents,
  findProjectRoot,
  resolvedProjectRoot,
  mergeSubagentSettings,
  normalizeConfig,
  piSubagentsInstalled,
  projectSettingsPath,
  saveSubagentSettings,
  subagentSettings,
};
