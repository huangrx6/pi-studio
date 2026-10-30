/**
 * Bounded, redacted snapshots of the exact messages Durable sends to a model.
 *
 * This module owns no execution state. A no-output prompt section records the
 * request resolution (model, thinking level, and tools), then the official
 * GenerationTask.beforeRequest hook publishes the final request after all
 * request hooks have run. The conversation service persists the resulting
 * JSON-safe DTO as a Studio-owned UI projection.
 */

const MAX_TRACE_CHARS = 512_000;
const MAX_SYSTEM_CHARS = 320_000;
const MAX_TRACE_TOOL_CHARS = 144_000;
const MAX_TOOL_DESCRIPTION_CHARS = 8_000;
const MAX_DEPTH = 16;
const MAX_PREPARED_REQUESTS = 64;
const PREPARED_REQUEST_TTL_MS = 10 * 60_000;
const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|bearer|token|client[-_]?secret|private[-_]?key|password|passwd|secret|credential)s?$/i;
const SENSITIVE_TEXT_PATTERNS = [
  [/(\bbearer\s+)[a-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]'],
  [/\bsk-[a-z0-9_-]{16,}\b/gi, '[REDACTED]'],
  [/\b((?:api[-_ ]?key|authorization|access[-_ ]?token|refresh[-_ ]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]'],
];

const preparedRequests = new Map();
const listeners = new Set();

function requestKey(conversationId) {
  return String(conversationId);
}

function approximateImageBytes(data) {
  if (typeof data !== 'string' || data.length === 0) return 0;
  return Math.floor((data.length * 3) / 4);
}

function sanitizeText(value) {
  let text = String(value);
  for (const [pattern, replacement] of SENSITIVE_TEXT_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function sanitizeValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sanitizeText(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (depth >= MAX_DEPTH) return '[嵌套层级已省略]';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: 'binary', bytes: value.byteLength };
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[循环引用]';
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value
      .map((item) => sanitizeValue(item, depth + 1, seen))
      .filter((item) => item !== undefined);
    seen.delete(value);
    return output;
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    const sanitized = sanitizeValue(item, depth + 1, seen);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  seen.delete(value);
  return output;
}

function normalizeContentBlock(block) {
  if (typeof block === 'string') return { type: 'text', text: sanitizeText(block) };
  if (!block || typeof block !== 'object') return { type: 'unknown', value: sanitizeValue(block) };
  if (block.type === 'text') return { type: 'text', text: sanitizeText(block.text || '') };
  if (block.type === 'image') {
    return {
      type: 'image',
      mimeType: String(block.mimeType || 'application/octet-stream'),
      bytes: approximateImageBytes(block.data),
      omitted: true,
    };
  }
  if (block.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: sanitizeText(block.thinking || ''),
      ...(block.redacted ? { redacted: true } : {}),
    };
  }
  if (block.type === 'toolCall') {
    return {
      type: 'toolCall',
      id: block.id === undefined ? undefined : String(block.id),
      name: String(block.name || 'tool'),
      arguments: sanitizeValue(block.arguments || {}),
    };
  }
  return {
    type: 'unknown',
    originalType: String(block.type || 'unknown'),
    value: sanitizeValue(block),
  };
}

function normalizeMessage(message, index) {
  if (!message || typeof message !== 'object') {
    return {
      index,
      role: 'unknown',
      content: [{ type: 'unknown', value: sanitizeValue(message) }],
    };
  }
  const content = typeof message.content === 'string'
    ? [{ type: 'text', text: sanitizeText(message.content) }]
    : Array.isArray(message.content)
      ? message.content.map(normalizeContentBlock)
      : [];
  if (message.role === 'system') {
    // Durable stores each prompt section separately. Expanding it here is
    // equivalent to replaying the logical system message before the request.
    for (const value of Object.values(message.sections || {})) {
      if (typeof value === 'string' && value.length > 0) {
        content.push({ type: 'text', text: sanitizeText(value) });
      }
    }
  }
  const output = {
    index,
    role: String(message.role || 'unknown'),
    content,
  };
  if (Number.isFinite(message.timestamp)) output.timestamp = message.timestamp;
  if (message.toolCallId !== undefined) output.toolCallId = String(message.toolCallId);
  if (message.toolName !== undefined) output.toolName = String(message.toolName);
  if (message.isError === true) output.isError = true;
  return output;
}

function messageCharacters(message) {
  return JSON.stringify(message).length;
}

function contentText(content) {
  return content.flatMap((block) => {
    if (block.type === 'text') return [block.text];
    if (block.type === 'thinking') return [block.thinking];
    if (block.type === 'toolCall') return [`${block.name} ${JSON.stringify(block.arguments)}`];
    if (block.type === 'image') return [`[图片 ${block.mimeType} ${block.bytes} bytes]`];
    return [];
  }).join('\n');
}

function boundedMessage(message, maximum) {
  if (messageCharacters(message) <= maximum) return message;
  const truncationMarker = '\n\n[此消息因请求快照体积上限而截断]';
  const text = contentText(message.content);
  const output = {
    ...message,
    content: [{
      type: 'text',
      text: `${text.slice(0, Math.max(0, maximum - truncationMarker.length - 320))}${truncationMarker}`,
    }],
    truncated: true,
  };
  let size = messageCharacters(output);
  while (size > maximum && output.content[0].text.length > truncationMarker.length) {
    const remove = Math.max(1, size - maximum + 16);
    const available = Math.max(
      0,
      output.content[0].text.length - truncationMarker.length - remove,
    );
    output.content[0].text = `${output.content[0].text.slice(0, available)}${truncationMarker}`;
    size = messageCharacters(output);
  }
  return output;
}

/**
 * Keep the whole first request in normal cases. For unusually large contexts,
 * preserve system instructions and the newest messages, because those explain
 * what the model is doing now; an explicit marker reports omitted history.
 */
function boundMessages(messages) {
  const fullSize = messages.reduce((total, message) => total + messageCharacters(message), 0);
  if (fullSize <= MAX_TRACE_CHARS) return { messages, truncated: false };

  const selected = new Map();
  let used = 0;
  const omissionMarker = {
    index: -1,
    role: 'trace',
    content: [{
      type: 'text',
      text: `[${messages.length} 条上下文中的较早消息因请求快照体积上限未显示]`,
    }],
  };
  const markerSize = messageCharacters(omissionMarker);
  const usable = MAX_TRACE_CHARS - markerSize;

  // Keep every system update that fits. The first baseline usually carries the
  // complete Harness prompt; later entries may carry dynamic skill/tool changes.
  let systemUsed = 0;
  for (const message of messages) {
    if (message.role !== 'system') continue;
    const remainingSystem = Math.min(MAX_SYSTEM_CHARS - systemUsed, usable - used);
    if (remainingSystem <= 240) break;
    const next = boundedMessage(message, remainingSystem);
    selected.set(next.index, next);
    systemUsed += messageCharacters(next);
    used += messageCharacters(next);
  }

  // Then preserve the newest non-system messages, because they say what the
  // model is being asked to do at this exact request boundary.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'system' || selected.has(index)) continue;
    const remaining = usable - used;
    if (remaining <= 240) break;
    const next = boundedMessage(message, remaining);
    selected.set(index, next);
    used += messageCharacters(next);
  }

  const bounded = [...selected.values()].sort((left, right) => left.index - right.index);
  const omitted = messages.length - selected.size;
  if (omitted > 0) {
    omissionMarker.content[0].text = `[${omitted} 条上下文消息因请求快照体积上限未显示]`;
    bounded.unshift(omissionMarker);
  }
  return { messages: bounded, truncated: true };
}

function normalizeTools(tools) {
  const normalized = [];
  let used = 0;
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = String(tool?.name || '').trim();
    if (!name) continue;
    const item = {
      name: name.slice(0, 160),
      description: String(tool?.description || '').slice(0, MAX_TOOL_DESCRIPTION_CHARS),
    };
    if (tool?.parameters !== undefined) item.parameters = sanitizeValue(tool.parameters);
    if (tool?.constrainedSampling !== undefined) {
      item.constrainedSampling = sanitizeValue(tool.constrainedSampling);
    }
    const size = JSON.stringify(item).length;
    if (used + size > MAX_TRACE_TOOL_CHARS) {
      normalized.push({
        name: '[其余工具定义已省略]',
        description: `请求快照中的工具定义超过 ${MAX_TRACE_TOOL_CHARS} 字符上限。`,
      });
      break;
    }
    normalized.push(item);
    used += size;
  }
  return normalized;
}

function requestStats(messages, tools) {
  let systemChars = 0;
  let userChars = 0;
  let assistantChars = 0;
  let toolResultChars = 0;
  let imageCount = 0;
  let toolCallCount = 0;
  for (const message of messages) {
    const chars = messageCharacters(message);
    if (message.role === 'system') systemChars += chars;
    else if (message.role === 'user') userChars += chars;
    else if (message.role === 'assistant') assistantChars += chars;
    else if (message.role === 'toolResult' || message.role === 'tool') toolResultChars += chars;
    for (const block of message.content) {
      if (block.type === 'image') imageCount += 1;
      if (block.type === 'toolCall') toolCallCount += 1;
    }
  }
  return {
    messageCount: messages.length,
    systemChars,
    userChars,
    assistantChars,
    toolResultChars,
    imageCount,
    toolCallCount,
    toolDefinitionCount: tools.length,
    estimatedChars: messages.reduce((total, message) => total + messageCharacters(message), 0)
      + tools.reduce((total, tool) => total + JSON.stringify(tool).length, 0),
  };
}

function capturePromptInput(input) {
  if (!input?.conversationId) return undefined;
  const model = input.agent?.model && typeof input.agent.model === 'object'
    ? {
        provider: String(input.agent.model.provider || ''),
        modelId: String(input.agent.model.modelId || ''),
      }
    : undefined;
  if (listeners.size === 0) return undefined;
  const key = requestKey(input.conversationId);
  preparedRequests.delete(key);
  const now = Date.now();
  preparedRequests.set(key, {
    capturedAt: now,
    model,
    thinkingLevel: String(input.agent?.thinkingLevel || ''),
    tools: normalizeTools(input.agent?.tools),
  });
  for (const [preparedKey, prepared] of preparedRequests) {
    if (now - prepared.capturedAt > PREPARED_REQUEST_TTL_MS) preparedRequests.delete(preparedKey);
  }
  while (preparedRequests.size > MAX_PREPARED_REQUESTS) {
    preparedRequests.delete(preparedRequests.keys().next().value);
  }
  // This section is a passive observer. Returning undefined adds no prompt text.
  return undefined;
}

async function publishRequestTrace(durable, request, api, context) {
  const key = requestKey(api.conversationId);
  const prepared = preparedRequests.get(key);
  preparedRequests.delete(key);
  if (listeners.size === 0) return;
  try {
    let attempt = 1;
    try {
      const live = await api.snapshot(durable.LiveDoc, api.conversationId, context);
      if (Number.isSafeInteger(live?.generation?.attempt) && live.generation.attempt > 0) {
        attempt = live.generation.attempt;
      }
    } catch {
      // The hook is recovery-safe even when the presentation snapshot is unavailable.
    }
    const resolved = prepared && Date.now() - prepared.capturedAt <= PREPARED_REQUEST_TTL_MS
      ? prepared
      : { model: undefined, thinkingLevel: '', tools: [] };
    const normalizedMessages = Array.isArray(request?.messages)
      ? request.messages.map(normalizeMessage)
      : [];
    const bounded = boundMessages(normalizedMessages);
    const taskId = String(api.taskId);
    const trace = {
      id: `${taskId}:${attempt}`,
      requestId: `${taskId}:${attempt}`,
      conversationId: key,
      taskId,
      attempt,
      createdAt: Date.now(),
      ...(resolved.model?.provider && resolved.model?.modelId ? { model: resolved.model } : {}),
      ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
      messages: bounded.messages,
      tools: resolved.tools,
      stats: requestStats(normalizedMessages, resolved.tools),
      truncated: bounded.truncated,
    };
    for (const listener of listeners) {
      try {
        const pending = listener(trace);
        if (pending && typeof pending.then === 'function') {
          pending.catch((error) => {
            console.warn('[pi-studio] request trace listener failed', error);
          });
        }
      } catch (error) {
        console.warn('[pi-studio] request trace listener failed', error);
      }
    }
  } catch (error) {
    // Observability must never change the provider request.
    console.warn('[pi-studio] request trace capture failed', error);
  }
}

function createStudioRequestTraceExtension(durable) {
  return durable.defineExtension({
    name: 'studio-request-trace',
    sections: [
      durable.section('studio-request-trace-capture', capturePromptInput, { tag: false }),
    ],
    hooks: [
      durable.hook(durable.GenerationTask, {
        async beforeRequest(request, api, context) {
          await publishRequestTrace(durable, request, api, context);
          return undefined;
        },
      }),
    ],
  });
}

function onRequestTrace(listener) {
  if (typeof listener !== 'function') throw new TypeError('request trace listener must be a function');
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = {
  MAX_TRACE_CHARS,
  boundMessages,
  createStudioRequestTraceExtension,
  normalizeRequestMessages: (messages) => (Array.isArray(messages) ? messages.map(normalizeMessage) : []),
  onRequestTrace,
  sanitizeValue,
};
