const fs = require('node:fs');
const path = require('node:path');

function readConfig(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`无法读取配置文件 ${path.basename(file)}，请先修复文件格式。`);
  }
}

function writeConfig(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const permissions = mode ?? (fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: permissions });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function httpUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname); }
  catch { return false; }
}

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
  if (!input.editing) {
    const modelId = String(input.modelId || '').trim();
    if (!modelId) throw new Error('请填写首个模型的 ID');
    provider.models = [{ id: modelId, name: String(input.modelName || modelId).trim() || modelId }];
  }
  return { ...config, providers: { ...providers, [id]: provider } };
}

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

function visibleProviderIds(auth, configuredProviders, enabledModels, currentModel, authenticatedProviders = []) {
  return new Set([
    ...Object.keys(auth), ...Object.keys(configuredProviders), ...authenticatedProviders,
    ...[...enabledModels, currentModel].filter((id) => typeof id === 'string' && id.includes('/')).map((id) => id.split('/')[0]),
  ]);
}

module.exports = { readConfig, writeConfig, updateMcp, updateProvider, updateCustomModel, visibleProviderIds };
