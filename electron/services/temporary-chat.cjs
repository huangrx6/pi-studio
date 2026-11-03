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
const durableView = require('./durable-view.cjs');

const chats = new Map();
let memoryRuntime;
let memoryOpening;

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
  // An explicit model switch should resolve that model's own preference instead
  // of carrying the previous conversation's effective thinking level into it.
  const preference = modelRef ? thinkingLevel : (thinkingLevel || fallback.thinkingLevel);
  return {
    model,
    selection: {
      ...modelInfoFor(
        model,
        os.tmpdir(),
        preference,
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
    // 1.5.0：watchEvents() 已移除，临时聊天同样走会话视图 watch。
    const watch = await conversation.watch(runtime.context);
    const initial = durableView.liveFromView(watch.value);
    entry = {
      busy: false,
      cancelled: false,
      conversation,
      hadImages: false,
      partial: initial.generation?.message,
      live: initial,
      entryIds: durableView.seedEntryIds(watch.value.entries),
      stream: watch,
    };
    chats.set(key, entry);
    watch.start(async (call) => {
      // Durable 的失败会直接结束 watch，因此只有 value 调用会到达这里。
      if (call.kind !== 'value') return;
      const live = durableView.liveFromView(call.value);
      for (const record of durableView.appendedEntries(entry.entryIds, call.value.entries)) {
        const message = assistantMessage(record.model?.[0]);
        if (!message) continue;
        entry.partial = undefined;
        send({ type: 'message', message });
      }
      const streamed = live.generation?.message;
      if (streamed && streamed !== entry.live?.generation?.message) {
        entry.partial = streamed;
        const message = assistantMessage(streamed);
        if (message) send({ type: 'message', message: { ...message, streaming: true } });
      }
      if (live.runFailure && live.runFailure !== entry.live?.runFailure) {
        send({
          type: 'error',
          message: live.runFailure.detail || live.runFailure.reason || '临时回复未完成',
        });
      }
      entry.live = live;
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
