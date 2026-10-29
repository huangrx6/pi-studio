/**
 * Pi 配置文件的读写与校验。
 *
 * 纯函数 + 文件 IO，不依赖 Electron，方便单测（见 scripts/settings-config.test.cjs）。
 * 所有写入都是「先写临时文件再 rename」的原子操作，避免配置写一半损坏。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 新会话默认放行的编码工具；与 Pi Studio 原有行为保持一致。 */
const DEFAULT_AGENT_TOOLS = Object.freeze(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']);
const MAX_AGENT_TOOLS = 256;

/** 工具名支持普通 SDK 名称、MCP 命名空间和 `*`；拒绝工具修饰符以免改变 SDK 语义。 */
function isValidAgentToolName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 120
    && !value.startsWith('+')
    && !value.startsWith('-')
    && /^[A-Za-z0-9_.:*\-]+$/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value);
}

function normalizeAgentToolNames(input, strict = false) {
  if (!Array.isArray(input)) {
    if (strict) throw new Error('Agent 工具列表格式无效');
    return [...DEFAULT_AGENT_TOOLS];
  }
  if (input.length > MAX_AGENT_TOOLS) throw new Error(`Agent 工具最多允许 ${MAX_AGENT_TOOLS} 项`);
  const names = [];
  const seen = new Set();
  for (const raw of input) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!isValidAgentToolName(name)) {
      if (strict) throw new Error(`Agent 工具名称无效：${String(raw)}`);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** 来源信息只用于设置页解释工具由谁提供，不会传给 Pi SDK。 */
function normalizeAgentToolSources(input, enabled) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const allowed = new Set(enabled);
  const text = (value, limit = 512) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const sources = {};
  for (const [name, value] of Object.entries(input)) {
    if (!allowed.has(name) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const source = text(value.source, 256);
    if (!source) continue;
    sources[name] = {
      source,
      label: text(value.label, 160) || source,
      scope: ['user', 'project', 'temporary', 'manual'].includes(value.scope) ? value.scope : 'user',
      path: text(value.path, 2048),
      baseDir: text(value.baseDir, 2048),
    };
  }
  return sources;
}

/**
 * 读取本地工具白名单。兼容最早的字符串数组格式，并保证旧配置默认仍只开放
 * 原有七项编码工具，不会因为升级后引入 `*` 突然开放全部扩展能力。
 */
function readAgentToolSelection(config) {
  const stored = config?.agentTools;
  if (Array.isArray(stored)) {
    const enabled = normalizeAgentToolNames(stored);
    return { enabled, sources: {} };
  }
  if (stored && typeof stored === 'object' && Array.isArray(stored.enabled)) {
    const enabled = normalizeAgentToolNames(stored.enabled);
    return { enabled, sources: normalizeAgentToolSources(stored.sources, enabled) };
  }
  return { enabled: [...DEFAULT_AGENT_TOOLS], sources: {} };
}

/** 保存工具白名单和来源快照；来源随工具保留，扩展暂时卸载后仍能解释它来自哪里。 */
function updateAgentTools(config, input) {
  const previous = readAgentToolSelection(config);
  const rawEnabled = Array.isArray(input) ? input : input?.enabled;
  const enabled = normalizeAgentToolNames(rawEnabled, true);
  const sources = input && !Array.isArray(input) && input.sources !== undefined
    ? normalizeAgentToolSources(input.sources, enabled)
    : Object.fromEntries(Object.entries(previous.sources).filter(([name]) => enabled.includes(name)));
  return { ...config, agentTools: { enabled, sources } };
}

/** 读 JSON 配置；文件不存在返回 fallback，格式损坏则抛错提示。 */
function readConfig(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`无法读取配置文件 ${path.basename(file)}，请先修复文件格式。`);
  }
}

/** 原子写 JSON：临时文件 + rename，保留原文件权限。 */
function writeConfig(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const permissions = mode ?? (fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: permissions });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/** 校验是否为合法的 http(s) 地址。 */
function httpUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname); }
  catch { return false; }
}

/** 新增 / 编辑 MCP 服务器（校验名称、传输方式与环境变量格式）。 */
function updateMcp(config, input) {
  const name = String(input.name || '').trim();
  const originalName = input.originalName;
  const servers = config.mcpServers || {};
  if (!name || ['__proto__', 'prototype', 'constructor'].includes(name)) throw new Error('请输入有效的服务器名称');
  if (originalName && !Object.hasOwn(servers, originalName)) throw new Error('这个 MCP 已不存在，请刷新后重试');
  if (name !== originalName && Object.hasOwn(servers, name)) throw new Error('同名 MCP 已存在');
  const server = { ...(originalName ? servers[originalName] : { enabled: true }) };
  delete server.command; delete server.args; delete server.url; delete server.type;
  if (input.transport === 'stdio') {
    const command = String(input.command || '').trim();
    if (!command) throw new Error('请输入启动命令');
    if (!Array.isArray(input.args) || !input.args.every((arg) => typeof arg === 'string')) throw new Error('启动参数格式无效');
    Object.assign(server, { command, args: input.args });
  } else if (input.transport === 'http') {
    const url = String(input.url || '').trim();
    if (!httpUrl(url)) throw new Error('请输入有效的 HTTP 或 HTTPS 地址');
    Object.assign(server, { type: 'http', url });
  } else throw new Error('不支持的传输方式');
  server.description = String(input.description || '').trim();
  if (input.env !== undefined) {
    const env = {};
    for (const line of String(input.env).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) throw new Error('环境变量格式应为 KEY=value，每行一个');
      env[match[1]] = match[2];
    }
    if (Object.keys(env).length > 0) server.env = env; else delete server.env;
  }
  const next = { ...servers };
  if (originalName && originalName !== name) delete next[originalName];
  return { ...config, mcpServers: { ...next, [name]: server } };
}

/** 新增 / 编辑模型提供方（密钥写入 auth.json，models.json 不保留明文）。 */
function updateProvider(config, input, knownProviders = []) {
  const id = String(input.providerId || '').trim();
  const baseUrl = String(input.baseUrl || '').trim();
  const api = String(input.api || '').trim();
  const providers = config.providers || {};
  const exists = Object.hasOwn(providers, id) || knownProviders.includes(id);
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) throw new Error('来源 ID 需要 2–64 个小写字母、数字、点、横线或下划线');
  if (!httpUrl(baseUrl) || !api) throw new Error('请填写有效的服务地址和 API 类型');
  if (input.editing && !exists) throw new Error('这个来源已不存在，请刷新后重试');
  if (!input.editing && exists) throw new Error('来源已存在，请使用编辑入口修改');
  const provider = { ...(providers[id] || {}), baseUrl, api };
  // A newly supplied key is stored in auth.json by the caller. Remove the
  // old models.json override so it cannot take precedence over that key.
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) delete provider.apiKey;
  if (typeof input.icon === 'string') {
    const icon = input.icon.trim();
    if (icon) provider.icon = icon; else delete provider.icon;
  }
  if (!input.editing) {
    const modelId = String(input.modelId || '').trim();
    if (!modelId) throw new Error('请填写首个模型的 ID');
    provider.models = [{ id: modelId, name: String(input.modelName || modelId).trim() || modelId }];
  }
  return { ...config, providers: { ...providers, [id]: provider } };
}

/** 新增 / 编辑自定义模型（上下文窗口、最大输出、图像输入、推理标记）。 */
function updateCustomModel(config, input, knownProviders = []) {
  const providerId = String(input.providerId || '').trim();
  const id = String(input.modelId || '').trim();
  const providers = config.providers || {};
  if (!id || !providerId) throw new Error('来源和模型 ID 必填');
  if (!Object.hasOwn(providers, providerId) && !knownProviders.includes(providerId)) throw new Error('请先添加模型来源');
  const provider = providers[providerId] || {};
  const list = Array.isArray(provider.models) ? provider.models : [];
  const existing = list.find((model) => model.id === id);
  if (input.editing && !existing) throw new Error('这个自定义模型已不存在，请刷新后重试');
  if (!input.editing && existing) throw new Error('模型已存在，请使用编辑入口修改');
  const model = { ...existing, id, name: String(input.name || id).trim() || id, reasoning: Boolean(input.reasoning) };
  for (const key of ['contextWindow', 'maxTokens']) {
    if (input[key] === undefined || input[key] === '') delete model[key];
    else {
      const value = Number(input[key]);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('上下文和最大输出必须是正整数');
      model[key] = value;
    }
  }
  model.input = ['text', ...(input.supportsImages ? ['image'] : []), ...(existing?.input || []).filter((item) => item !== 'text' && item !== 'image')];
  const updated = existing ? list.map((item) => item.id === id ? model : item) : [...list, model];
  return { ...config, providers: { ...providers, [providerId]: { ...provider, models: updated } } };
}

/** 计算设置页应展示哪些提供方：有密钥、已启用、或当前模型所属。 */
function visibleProviderIds(auth, configuredProviders, enabledModels, currentModel, authenticatedProviders = []) {
  return new Set([
    ...Object.keys(auth), ...Object.keys(configuredProviders), ...authenticatedProviders,
    ...[...enabledModels, currentModel].filter((id) => typeof id === 'string' && id.includes('/')).map((id) => id.split('/')[0]),
  ]);
}

module.exports = {
  DEFAULT_AGENT_TOOLS,
  readConfig,
  writeConfig,
  readAgentToolSelection,
  updateAgentTools,
  updateMcp,
  updateProvider,
  updateCustomModel,
  visibleProviderIds,
};
