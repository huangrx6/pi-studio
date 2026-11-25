/**
 * In-memory temporary conversations.
 *
 * Temporary chats use the same Pi Durable execution engine as regular Studio
 * conversations, with a private MemoryStorage. Transcripts, images, and run
 * state live only in memory and never write SQLite, JSONL, or attachments.
 * Tool availability, permissions, and prompt harness follow Studio's temporary
 * profile bindings when configured.
 */

const fs = require('node:fs');
const os = require('node:os');
const { serializeMessage } = require('../core/serialize.cjs');
const { databasePath } = require('../core/studio-db.cjs');
const { getTemporaryHarnessProfile } = require('../core/app-settings.cjs');
const { getStudioModelsRuntime } = require('../core/studio-models.cjs');
const {
  modelInfoFor,
  runtimeModelFor,
  splitModelRef,
} = require('./models.cjs');
const { getDurableRuntime } = require('../runtime/durable-runtime.cjs');
const durableView = require('../runtime/view.cjs');
const { releaseProviderSession } = require('../runtime/provider-session.cjs');
const { temporarySafeExtensions } = require('./studio-extensions.cjs');
const { temporaryRuntimeSelection } = require('../runtime/tool-selection.cjs');
const { evaluateTemporaryToolCall } = require('../capabilities/permissions/index.cjs');
const { requestPolicyConfirmation } = require('./confirmations.cjs');
const { redactToolSecrets, resolveToolSecrets } = require('./secret-vault.cjs');
const { CODING_RULES, toolGuidance } = require('../capabilities/harness/index.cjs');

const chats = new Map();
let memoryRuntime;
let memoryOpening;

function buildDefaultInstructions(hasTools) {
  return [
    'You are Pi in a temporary chat inside Pi Studio.',
    hasTools
      ? 'Answer directly in the user language. No workspace files are attached, but read-only user plugin tools are available when helpful.'
      : 'Answer directly in the user language. No workspace is attached and no tools are available.',
    'Messages, images, and transcript state exist only in process memory and disappear when the chat or app closes.',
  ].join('\n');
}

function buildHarnessInstructions(tools, harnessProfile) {
  if (!harnessProfile) return buildDefaultInstructions(tools.length > 0);
  const sections = harnessProfile.sections || {};
  const overrides = harnessProfile.sectionOverrides || {};
  const parts = [];
  if (sections.preamble !== false) {
    parts.push(
      overrides.preamble?.trim()
      || [
        'You are Pi in a temporary chat inside Pi Studio.',
        tools.length > 0
          ? 'Answer directly in the user language. Use the configured tools and MCP services only when helpful.'
          : 'Answer directly in the user language. No workspace is attached and no tools are available.',
      ].join('\n'),
    );
  }
  if (sections.tools !== false && tools.length > 0) {
    parts.push(overrides.tools?.trim() || toolGuidance({ agent: { tools } }, harnessProfile));
  }
  if (sections.rules !== false) {
    parts.push(overrides.rules?.trim() || CODING_RULES);
  }
  if (sections.addendum !== false) {
    const addendum = overrides.addendum?.trim() || String(harnessProfile.customInstructions || '').trim();
    if (addendum) parts.push(addendum);
  }
  parts.push('Messages, images, and transcript state exist only in process memory and disappear when the chat or app closes.');
  return parts.filter(Boolean).join('\n\n');
}

function createTemporaryPermissionsExtension(durable) {
  return durable.defineExtension({
    name: 'studio-temporary-permissions',
    hooks: [
      durable.hook(durable.ToolTask, {
        async beforeTool(call) {
          const secrets = await resolveToolSecrets(call.arguments || {});
          const evaluatedCall = secrets.expanded
            ? { ...call, arguments: secrets.arguments }
            : call;
          const evaluation = await evaluateTemporaryToolCall(evaluatedCall);
          if (evaluation.decision === 'allow') return;
          if (evaluation.decision === 'deny') {
            return {
              block: secrets.redact(
                `${evaluation.hardProtection?.title || '操作被权限策略拒绝'}：${evaluation.explanation}`,
              ),
            };
          }
          const response = await requestPolicyConfirmation(secrets.redact({
            sessionId: '',
            cwd: evaluation.cwd,
            tool: call.name,
            decision: evaluation.decision,
            explanation: evaluation.explanation,
            risk: evaluation.risk,
            rememberScopes: ['once'],
            title: evaluation.risk?.title || '允许在临时对话中执行这个工具？',
            message: call.name === 'bash'
              ? `执行命令 · ${String(call.arguments?.command || '')}${secrets.expanded ? `\n\n使用凭据：${secrets.referenced.join('、')}` : ''}`
              : call.arguments?.path
                ? `${call.name} → ${String(call.arguments.path)}${secrets.expanded ? `\n\n使用凭据：${secrets.referenced.join('、')}` : ''}`
                : `${call.name}\n\n${JSON.stringify(call.arguments, null, 2).slice(0, 4_000)}${secrets.expanded ? `\n\n使用凭据：${secrets.referenced.join('、')}` : ''}`,
          }));
          if (!response.accepted) return { block: '用户拒绝了这次工具调用。' };
        },
        async afterTool(_call, result) {
          return redactToolSecrets(result);
        },
      }),
    ],
  });
}

function syncExtensionEntries(runtime, entries, permissionExtension) {
  const previous = runtime.installedExtensions || new Map();
  const desiredMap = new Map(entries.map((ext) => [ext.name, ext]));
  if (permissionExtension) desiredMap.set(permissionExtension.name, permissionExtension);
  for (const [name, ext] of previous.entries()) {
    if (desiredMap.has(name) && previous.get(name) === desiredMap.get(name)) continue;
    try { runtime.registry?.uninstall?.(ext); } catch { /* ignore */ }
    previous.delete(name);
  }
  const installed = [];
  for (const ext of desiredMap.values()) {
    try {
      if (previous.get(ext.name) !== ext) {
        runtime.registry.install(ext);
        previous.set(ext.name, ext);
      }
      installed.push(ext);
    } catch {
      // Ignore conflicting or unloaded optional plugin tools in temporary chat.
    }
  }
  runtime.installedExtensions = previous;
  return installed;
}

function syncTemporarySafeExtensions(runtime) {
  const desired = temporarySafeExtensions();
  const desiredExtensions = desired.map((entry) => entry.extension);
  const installed = syncExtensionEntries(runtime, desiredExtensions);
  const installedNames = new Set(installed.map((ext) => ext.name));
  const extensions = [];
  const tools = [];
  const signatureEntries = [];
  for (const entry of desired) {
    if (!installedNames.has(entry.extension.name)) continue;
    extensions.push(entry.extension);
    const toolsByName = new Map(
      (entry.extension.tools || [])
        .filter((tool) => tool && typeof tool.name === 'string')
        .map((tool) => [tool.name, tool]),
    );
    const entryToolNames = Array.isArray(entry.toolNames) && entry.toolNames.length > 0
      ? entry.toolNames
      : [...toolsByName.keys()];
    for (const toolName of entryToolNames) {
      if (typeof toolName === 'string' && toolName) {
        tools.push(toolsByName.get(toolName) || { name: toolName });
      }
    }
    signatureEntries.push([entry.extension.name, entryToolNames]);
  }
  return {
    extensions,
    tools,
    instructions: buildDefaultInstructions(tools.length > 0),
    signature: JSON.stringify(signatureEntries),
  };
}

async function resolveTemporaryCapabilities(runtime, durableRuntime) {
  const hasPersistedDb = fs.existsSync(databasePath()) && Boolean(durableRuntime?.registry);
  if (!hasPersistedDb) {
    return syncTemporarySafeExtensions(runtime);
  }
  const selection = await temporaryRuntimeSelection();
  const harnessProfile = getTemporaryHarnessProfile();
  const permissionExt = selection.tools.length > 0
    ? (runtime.permissionExtension ??= createTemporaryPermissionsExtension(runtime.durable))
    : undefined;
  const installedExtensions = syncExtensionEntries(
    runtime,
    selection.extensions,
    permissionExt,
  );
  const instructions = buildHarnessInstructions(selection.tools, harnessProfile);
  const signature = JSON.stringify({
    profileId: selection.profile.id,
    tools: selection.tools.map((tool) => tool.name),
    extensions: installedExtensions.map((ext) => ext.name),
    instructions,
  });
  return {
    extensions: installedExtensions,
    tools: selection.tools,
    instructions,
    signature,
  };
}

async function openMemoryRuntime() {
  if (memoryRuntime) return memoryRuntime;
  if (memoryOpening) return memoryOpening;
  memoryOpening = (async () => {
    const durableRuntime = await getDurableRuntime();
    const studioModels = await getStudioModelsRuntime();
    const storage = new durableRuntime.durable.MemoryStorage();
    const registry = durableRuntime.durable.createRegistry();
    let envFactory;
    if (durableRuntime.registry) {
      try {
        const durableEnv = await import('@earendil-works/pi-durable/env/node');
        envFactory = ({ cwd }) => new durableEnv.NodeExecutionEnv({
          cwd: cwd || os.tmpdir(),
          shellEnv: process.env,
        });
      } catch {
        envFactory = undefined;
      }
    }
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
      ...(envFactory ? { env: envFactory } : {}),
    }, durableRuntime.context);
    memoryRuntime = {
      durable: durableRuntime.durable,
      context: durableRuntime.context,
      cleanupSessionResources: durableRuntime.cleanupSessionResources,
      durableRuntime,
      harness,
      registry,
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

function chatMessage(message) {
  return message?.role === 'assistant' || message?.role === 'toolResult'
    ? serializeMessage(message)
    : undefined;
}

async function temporaryPrompt(owner, payload, send) {
  const input = validateInput(payload);
  const key = `${owner}:${payload.id}`;
  let entry = chats.get(key);
  if (entry?.busy || entry?.closing) throw new Error('请等待当前回复完成，或先停止回复');

  const runtime = await openMemoryRuntime();
  const { model, selection } = await resolveModel(payload.modelRef, payload.thinkingLevel);
  if (
    (input.images.length || entry?.hadImages)
    && !(Array.isArray(model.input) && model.input.includes('image'))
  ) {
    throw new Error('当前模型不支持图片，请切换到支持图片的模型');
  }

  if (!entry) {
    const safeTools = await resolveTemporaryCapabilities(runtime, runtime.durableRuntime);
    const extensionSignature = safeTools.signature;
    const conversation = await runtime.harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: {
        model: { provider: model.provider, modelId: model.id },
        thinkingLevel: selection.effectiveThinkingLevel,
        cwd: os.tmpdir(),
        extensions: safeTools.extensions,
        tools: safeTools.tools,
        instructions: safeTools.instructions,
      },
    }, runtime.context);
    // 1.5.0：watchEvents() 已移除，临时聊天同样走会话视图 watch。
    const watch = await conversation.watch(runtime.context);
    const initial = durableView.liveFromView(watch.value);
    entry = {
      runtime,
      busy: false,
      cancelled: false,
      conversation,
      extensionSignature,
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
        const message = chatMessage(record.model?.[0]);
        if (!message) continue;
        entry.partial = undefined;
        send({ type: 'message', message });
      }
      const streamed = live.generation?.message;
      if (streamed && streamed !== entry.live?.generation?.message) {
        entry.partial = streamed;
        const message = chatMessage(streamed);
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
    const safeTools = await resolveTemporaryCapabilities(runtime, runtime.durableRuntime);
    const nextSignature = safeTools.signature;
    const toolsChanged = nextSignature !== entry.extensionSignature;
    if (toolsChanged) entry.extensionSignature = nextSignature;
    await entry.conversation.configure({
      model: { provider: model.provider, modelId: model.id },
      thinkingLevel: selection.effectiveThinkingLevel,
      ...(toolsChanged ? {
        extensions: safeTools.extensions,
        tools: safeTools.tools,
        instructions: safeTools.instructions,
      } : {}),
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

async function disposeTemporaryEntry(entry) {
  await entry.conversation.abort(entry.runtime.context).catch(() => {});
  await entry.stream.stop().catch(() => {});
  await releaseProviderSession(entry.runtime, entry.conversation.id);
}

async function closeTemporary(owner, id) {
  const key = `${owner}:${id}`;
  const entry = chats.get(key);
  if (!entry) return;
  if (entry.closing) return entry.closing;
  entry.cancelled = true;
  entry.closing = disposeTemporaryEntry(entry);
  await entry.closing;
  chats.delete(key);
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
  await Promise.all([...chats.values()].map((entry) => {
    entry.cancelled = true;
    entry.closing ??= disposeTemporaryEntry(entry);
    return entry.closing;
  }));
  chats.clear();
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
