/**
 * In-memory temporary conversations.
 *
 * Temporary chats use the same Pi Durable execution engine as regular Studio
 * conversations, but a private MemoryStorage and an empty registry. They never
 * write SQLite, JSONL, workspace files, credentials, or attachment files.
 */

const os = require('node:os');
const { serializeMessage } = require('../core/serialize.cjs');
const { getStudioModelsRuntime } = require('../core/studio-models.cjs');
const {
  modelInfoFor,
  runtimeModelFor,
  splitModelRef,
} = require('./models.cjs');
const { getDurableRuntime } = require('./durable-runtime.cjs');

const chats = new Map();
let memoryRuntime;
let memoryOpening;

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function appendAtPath(value, segments, delta) {
  if (segments.length === 0 || typeof value !== 'object' || value === null) return value;
  let current = value;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (current[segment] === undefined) {
      current[segment] = typeof segments[index + 1] === 'number' ? [] : {};
    }
    current = current[segment];
  }
  const last = segments.at(-1);
  current[last] = `${current[last] || ''}${delta}`;
  return value;
}

function applyMessageChanges(message, changes) {
  const next = {
    ...message,
    content: Array.isArray(message.content) ? cloneJson(message.content) : [],
  };
  for (const change of changes || []) {
    if (
      change.type === 'text_start'
      || change.type === 'thinking_start'
      || change.type === 'toolcall_start'
      || change.type === 'block'
    ) {
      next.content[change.contentIndex] = cloneJson(change.block);
      continue;
    }
    if (change.type === 'text_delta' || change.type === 'thinking_delta') {
      const key = change.type === 'thinking_delta' ? 'thinking' : 'text';
      const current = next.content[change.contentIndex] || { type: key, [key]: '' };
      next.content[change.contentIndex] = {
        ...current,
        [key]: `${current[key] || ''}${change.delta}`,
      };
      continue;
    }
    if (change.type === 'toolcall_delta') {
      const current = cloneJson(next.content[change.contentIndex] || {
        type: 'toolCall',
        arguments: {},
      });
      next.content[change.contentIndex] = appendAtPath(
        current,
        ['arguments', ...change.path],
        change.delta,
      );
      continue;
    }
    if (change.type === 'message') {
      next.content = cloneJson(change.message.content);
    }
  }
  return next;
}

async function openMemoryRuntime() {
  if (memoryRuntime) return memoryRuntime;
  if (memoryOpening) return memoryOpening;
  memoryOpening = (async () => {
    const durableRuntime = await getDurableRuntime();
    const studioModels = await getStudioModelsRuntime();
    const storage = new durableRuntime.durable.MemoryStorage();
    const registry = durableRuntime.durable.createRegistry();
    const harness = await durableRuntime.durable.Harness.open(storage, {
      models: studioModels.models,
      registry,
      identity: {
        userAgent: 'detailed',
        attribution: {
          name: 'Pi Studio Temporary Chat',
          url: 'https://github.com/huangrx6/pi-studio',
          categories: ['desktop-agent'],
        },
      },
      settings: {
        progress: {
          partialIntervalMs: 32,
          outputIntervalMs: 48,
        },
        contextRetentionMs: 30_000,
        documentRetentionMs: 30_000,
        afterFailedRun: 'withdraw',
      },
    }, durableRuntime.context);
    memoryRuntime = {
      durable: durableRuntime.durable,
      context: durableRuntime.context,
      harness,
      storage,
    };
    return memoryRuntime;
  })().finally(() => {
    memoryOpening = undefined;
  });
  return memoryOpening;
}

async function closeMemoryRuntime() {
  if (memoryOpening) await memoryOpening.catch(() => {});
  const current = memoryRuntime;
  memoryRuntime = undefined;
  if (!current) return;
  await current.harness.close(current.context).catch(() => {});
  await current.storage.close?.(current.context).catch(() => {});
}

async function resolveModel(modelRef, thinkingLevel) {
  const studioModels = await getStudioModelsRuntime();
  const fallback = await require('./models.cjs').modelInfo();
  const ref = splitModelRef(modelRef || fallback.modelRef);
  const model = runtimeModelFor(studioModels.models, ref);
  if (!model) throw new Error('请选择一个已配置的模型');
  return {
    model,
    selection: {
      ...modelInfoFor(
        model,
        os.tmpdir(),
        thinkingLevel || fallback.thinkingLevel,
        ref ? `${ref.provider}/${ref.modelId}` : fallback.modelRef,
        studioModels,
      ),
      source: 'session',
    },
  };
}

async function temporaryModel(payload = {}) {
  return (await resolveModel(payload.modelRef, payload.thinkingLevel)).selection;
}

function validateInput(payload) {
  if (typeof payload?.id !== 'string' || !/^[\w-]{1,100}$/.test(payload.id)) {
    throw new Error('临时聊天标识无效');
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const images = payload.images ?? [];
  if (!Array.isArray(images) || images.length > 8) throw new Error('最多上传 8 张图片');
  if (text.length > 100_000) throw new Error('消息过长，请缩短后发送');
  let total = 0;
  for (const image of images) {
    if (
      !image
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)
      || typeof image.data !== 'string'
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    ) {
      throw new Error('图片格式无效');
    }
    total += image.data.length;
    if (!image.data || image.data.length > 14_000_000 || total > 40_000_000) {
      throw new Error('图片过大，请压缩后重试');
    }
  }
  if (!text && !images.length) throw new Error('请输入消息或添加图片');
  return {
    text,
    images: images.map((image) => ({
      type: 'image',
      data: image.data,
      mimeType: image.mimeType,
    })),
  };
}

function content(input) {
  return [
    ...(input.text ? [{ type: 'text', text: input.text }] : []),
    ...input.images,
  ];
}

function assistantMessage(message) {
  return message?.role === 'assistant' ? serializeMessage(message) : undefined;
}

async function temporaryPrompt(owner, payload, send) {
  const input = validateInput(payload);
  const key = `${owner}:${payload.id}`;
  let entry = chats.get(key);
  if (entry?.busy) throw new Error('请等待当前回复完成，或先停止回复');

  const runtime = await openMemoryRuntime();
  const { model, selection } = await resolveModel(payload.modelRef, payload.thinkingLevel);
  if (
    (input.images.length || entry?.hadImages)
    && !(Array.isArray(model.input) && model.input.includes('image'))
  ) {
    throw new Error('当前模型不支持图片，请切换到支持图片的模型');
  }

  if (!entry) {
    const conversation = await runtime.harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: {
        model: { provider: model.provider, modelId: model.id },
        thinkingLevel: selection.effectiveThinkingLevel,
        cwd: os.tmpdir(),
        extensions: [],
        tools: [],
        instructions: [
          'You are Pi in a temporary chat inside Pi Studio.',
          'Answer directly in the user language. No workspace is attached and no tools are available.',
          'Messages, images, and transcript state exist only in process memory and disappear when the chat or app closes.',
        ].join('\n'),
      },
    }, runtime.context);
    const stream = await runtime.durable.watchEvents(
      runtime.harness,
      conversation.id,
      runtime.context,
    );
    entry = {
      busy: false,
      cancelled: false,
      conversation,
      hadImages: false,
      partial: undefined,
      stream,
    };
    chats.set(key, entry);
    stream.start(async (events) => {
      for (const event of events) {
        if (event.type === 'message_start' && event.message?.role === 'assistant') {
          entry.partial = cloneJson(event.message);
          continue;
        }
        if (event.type === 'message_update') {
          entry.partial = applyMessageChanges(entry.partial || {
            role: 'assistant',
            content: [],
            timestamp: Date.now(),
            stopReason: 'pending',
          }, event.changes);
          const message = assistantMessage({ ...entry.partial, usage: event.usage });
          if (message) send({ type: 'message', message: { ...message, streaming: true } });
          continue;
        }
        if (event.type === 'message_end') {
          const message = assistantMessage(event.entry?.model?.[0]);
          entry.partial = undefined;
          if (message) send({ type: 'message', message });
          continue;
        }
        if (event.type === 'task_failed') {
          send({ type: 'error', message: event.message });
        }
      }
    });
  } else {
    await entry.conversation.configure({
      model: { provider: model.provider, modelId: model.id },
      thinkingLevel: selection.effectiveThinkingLevel,
    }, runtime.context);
  }

  entry.busy = true;
  entry.cancelled = false;
  entry.hadImages ||= input.images.length > 0;
  try {
    const submission = await entry.conversation.submit({
      type: 'input',
      content: content(input),
      requestId: `${owner}-${payload.id}-${Date.now()}-${crypto.randomUUID()}`,
    }, runtime.context);
    const settled = await submission.wait(runtime.context);
    if (settled.status === 'unanswered' && !entry.cancelled) {
      throw new Error(settled.reason || '临时回复未完成');
    }
  } finally {
    entry.busy = false;
    send({ type: 'done' });
  }
}

async function stopTemporary(owner, id) {
  const entry = chats.get(`${owner}:${id}`);
  if (!entry) return;
  entry.cancelled = true;
  await entry.conversation.abort((await openMemoryRuntime()).context).catch(() => {});
}

async function closeTemporary(owner, id) {
  const key = `${owner}:${id}`;
  const entry = chats.get(key);
  if (!entry) return;
  chats.delete(key);
  entry.cancelled = true;
  await entry.conversation.abort((await openMemoryRuntime()).context).catch(() => {});
  await entry.stream.stop().catch(() => {});
  if (chats.size === 0) await closeMemoryRuntime();
}

async function closeOwner(owner) {
  const prefix = `${owner}:`;
  const ids = [...chats.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
  await Promise.all(ids.map((id) => closeTemporary(owner, id)));
}

async function shutdownTemporaryChats() {
  const entries = [...chats.entries()];
  chats.clear();
  await Promise.all(entries.map(async ([key, entry]) => {
    entry.cancelled = true;
    await entry.stream.stop().catch(() => {});
    await entry.conversation.abort(memoryRuntime?.context ?? (await openMemoryRuntime()).context).catch(() => {});
  }));
  await closeMemoryRuntime();
}

module.exports = {
  closeOwner,
  closeTemporary,
  shutdownTemporaryChats,
  stopTemporary,
  temporaryModel,
  temporaryPrompt,
  validateInput,
};
