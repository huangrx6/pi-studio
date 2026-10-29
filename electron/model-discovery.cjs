/**
 * 第三方模型列表发现。
 *
 * 这里只接受显式的 HTTP(S) 地址，GET 请求失败时只返回有限长度的状态说明，
 * 不记录 URL 查询参数、Authorization 或响应正文，避免凭据进入界面与日志。
 */

const MAX_MODELS = 2000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const {
  effectiveThinkingLevels,
  normalizeThinkingLevels,
} = require('./core/thinking-levels.cjs');
const {
  markDiscoveryDeclarations,
  mergeDiscoveredModelMetadata,
} = require('./core/model-metadata.cjs');

function httpUrl(value) {
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** 显式地址优先；否则从服务地址推导常见的 `/models` 端点。 */
function modelListEndpoint(baseUrl, configuredUrl = '') {
  const explicit = String(configuredUrl || '').trim();
  if (explicit) {
    if (!httpUrl(explicit)) throw new Error('模型列表地址必须是有效的 HTTP 或 HTTPS 地址');
    return new URL(explicit).href;
  }
  const base = String(baseUrl || '').trim();
  if (!httpUrl(base)) throw new Error('服务地址无效，无法推导模型列表地址');
  const url = new URL(base);
  url.hash = '';
  url.search = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  return url.href;
}

function asModelArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const value of [payload.data, payload.models, payload.result, payload.data?.data, payload.data?.models]) {
    if (Array.isArray(value)) return value;
  }
  // 少数代理以 { "model-id": { ...metadata } } 的 map 形式返回。
  return Object.entries(payload)
    .filter(([key, value]) => key !== 'error' && value && typeof value === 'object' && !Array.isArray(value))
    .map(([id, value]) => ({ id, ...value }));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function firstPositive(...values) {
  for (const value of values) {
    const number = positiveInteger(value);
    if (number) return number;
  }
  return undefined;
}

function hasDefinedProperty(object, key) {
  return object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key)
    && object[key] !== undefined && object[key] !== null;
}

function explicitThinkingLevels(item, capabilities) {
  const candidates = [
    item.thinkingLevels,
    item.thinking_levels,
    item.reasoningLevels,
    item.reasoning_levels,
    item.supportedThinkingLevels,
    item.supported_thinking_levels,
    item.supportedReasoningLevels,
    item.supported_reasoning_levels,
    item.supported_reasoning_efforts,
    item.reasoning,
    item.thinking,
    item.reasoning_effort,
    item.reasoning?.levels,
    item.reasoning?.supported_levels,
    item.reasoning?.efforts,
    item.thinking?.levels,
    item.thinking?.supported_levels,
    item.thinking?.efforts,
    item.reasoning_effort?.values,
    item.reasoning_effort?.supported_values,
    item.reasoning_effort?.enum,
    capabilities.thinkingLevels,
    capabilities.thinking_levels,
    capabilities.reasoningLevels,
    capabilities.reasoning_levels,
    capabilities.reasoning,
    capabilities.thinking,
    capabilities.reasoning_effort,
    capabilities.reasoning?.levels,
    capabilities.reasoning?.supported_levels,
    capabilities.reasoning?.efforts,
    capabilities.thinking?.levels,
    capabilities.thinking?.supported_levels,
    capabilities.thinking?.efforts,
    capabilities.reasoning_effort?.values,
    capabilities.reasoning_effort?.supported_values,
    capabilities.reasoning_effort?.enum,
  ];
  for (const candidate of candidates) {
    const levels = normalizeThinkingLevels(candidate, true);
    if (levels.length > 0) return levels;
  }
  return [];
}

/**
 * 归一化 OpenAI、Anthropic 代理、OpenRouter 和常见自定义网关的列表响应。
 * 第三方通常只返回 ID；上下文、最大输出与能力字段存在时才写入，之后可在
 * 来源内逐个编辑。
 */
function normalizeDiscoveredModels(payload) {
  const result = [];
  const seen = new Set();
  for (const raw of asModelArray(payload)) {
    if (result.length >= MAX_MODELS) break;
    const item = raw && typeof raw === 'object' ? raw : { id: raw };
    const id = String(item.id || item.model || item.slug || item.name || '').trim();
    if (!id || id.length > 256 || seen.has(id) || ['__proto__', 'prototype', 'constructor'].includes(id)) continue;
    const modalities = item.input || item.modalities?.input || item.architecture?.input_modalities;
    const modalityList = Array.isArray(modalities) ? modalities.map((value) => String(value).toLowerCase()) : [];
    const capabilities = item.capabilities && typeof item.capabilities === 'object' ? item.capabilities : {};
    const declaredThinkingLevels = explicitThinkingLevels(item, capabilities);
    const declaredReasoning = [
      item.reasoning,
      item.supports_reasoning,
      item.supportsReasoning,
      item.thinking,
      item.reasoning_effort,
      item.reasoningEffort,
      capabilities.reasoning,
      capabilities.reasoning_effort,
      capabilities.reasoningEffort,
      capabilities.thinking,
    ].some((value) => value !== undefined && value !== null);
    const supportedParameters = [
      ...(Array.isArray(item.supported_parameters) ? item.supported_parameters : []),
      ...(Array.isArray(item.supportedParameters) ? item.supportedParameters : []),
      ...(Array.isArray(capabilities.supported_parameters) ? capabilities.supported_parameters : []),
    ].map((value) => String(value).toLowerCase());
    const supportedParametersDeclared = hasDefinedProperty(item, 'supported_parameters')
      || hasDefinedProperty(item, 'supportedParameters')
      || hasDefinedProperty(capabilities, 'supported_parameters');
    const reasoningDeclared = declaredThinkingLevels.length > 0
      || declaredReasoning
      || supportedParametersDeclared;
    const supportsImagesDeclared = [
      item.supportsImages,
      item.supports_images,
      item.vision,
      item.modalities?.input,
      item.architecture?.input_modalities,
      capabilities.vision,
      capabilities.image_input,
    ].some((value) => value !== undefined && value !== null)
      || Array.isArray(modalities);
    const reasoning = declaredThinkingLevels.length > 0
      || supportedParameters.some((value) => ['reasoning', 'reasoning_effort', 'include_reasoning', 'thinking'].includes(value))
      || Boolean(
        item.reasoning
        || item.supports_reasoning
        || item.supportsReasoning
        || item.thinking
        || capabilities.reasoning
        || capabilities.thinking,
      );
    const model = {
      id,
      name: String(item.display_name || item.displayName || item.name || id).trim() || id,
      supportsImages: Boolean(
        item.supportsImages
        || item.supports_images
        || item.vision
        || capabilities.vision
        || capabilities.image_input
        || modalityList.some((value) => value === 'image' || value === 'vision'),
      ),
      reasoning,
      thinkingLevels: effectiveThinkingLevels(declaredThinkingLevels, reasoning),
    };
    const contextWindow = firstPositive(
      item.contextWindow,
      item.context_window,
      item.context_length,
      item.contextLength,
      item.max_context_length,
      item.max_context_tokens,
      item.limit?.context,
      item.limits?.context,
    );
    const maxTokens = firstPositive(
      item.maxTokens,
      item.max_tokens,
      item.max_output_tokens,
      item.maxOutputTokens,
      item.output_token_limit,
      item.limit?.output,
      item.limits?.output,
    );
    if (contextWindow) model.contextWindow = contextWindow;
    if (maxTokens) model.maxTokens = maxTokens;
    markDiscoveryDeclarations(model, {
      contextWindowDeclared: Boolean(contextWindow),
      maxTokensDeclared: Boolean(maxTokens),
      nameDeclared: hasDefinedProperty(item, 'display_name')
        || hasDefinedProperty(item, 'displayName')
        || hasDefinedProperty(item, 'name'),
      reasoningDeclared,
      supportsImagesDeclared,
      thinkingLevelsDeclared: declaredThinkingLevels.length > 0,
    });
    seen.add(id);
    result.push(model);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function payloadErrorMessage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const failed = payload.success === false || payload.ok === false;
  const errorValue = payload.error;
  if (!failed && !errorValue) return '';
  const message = typeof errorValue === 'string'
    ? errorValue
    : errorValue?.message || payload.message || payload.msg || payload.error_message;
  if (typeof message !== 'string' || !message.trim()) return '';
  const code = errorValue?.code ?? payload.code;
  const prefix = code === undefined || code === null || code === '' ? '' : `${String(code)} `;
  return `${prefix}${message}`.replace(/\s+/g, ' ').trim().slice(0, 240);
}

async function readLimitedText(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('模型列表响应过大');
  if (!response.body?.getReader) return (await response.text()).slice(0, MAX_RESPONSE_BYTES);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('模型列表响应过大');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function fetchProviderModelDiscovery({
  providerId,
  baseUrl,
  modelsUrl,
  api,
  apiKey,
  fetcher = globalThis.fetch,
  timeoutMs = 15000,
  officialCatalog = [],
  metadataCatalogs = [],
} = {}) {
  if (typeof fetcher !== 'function') throw new Error('当前运行环境不支持模型发现请求');
  const endpoint = modelListEndpoint(baseUrl, modelsUrl);
  const headers = { Accept: 'application/json', 'User-Agent': 'Pi-Studio' };
  if (apiKey) {
    if (api === 'anthropic-messages') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (api === 'google-generative-ai') {
      headers['x-goog-api-key'] = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }
  const response = await fetcher(endpoint, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await readLimitedText(response);
  if (!response.ok) {
    const detail = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    throw new Error(`模型列表请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('模型列表接口没有返回有效的 JSON');
  }
  const payloadError = payloadErrorMessage(payload);
  if (payloadError) throw new Error(`模型列表接口返回错误：${payloadError}`);
  const normalized = normalizeDiscoveredModels(payload);
  const models = mergeDiscoveredModelMetadata(normalized, {
    providerId,
    baseUrl,
    catalogs: metadataCatalogs.length > 0 ? metadataCatalogs : [officialCatalog],
  });
  return { endpoint, models };
}

module.exports = {
  MAX_MODELS,
  MAX_RESPONSE_BYTES,
  httpUrl,
  modelListEndpoint,
  normalizeDiscoveredModels,
  payloadErrorMessage,
  fetchProviderModelDiscovery,
  explicitThinkingLevels,
};
