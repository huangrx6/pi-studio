/** Temporary chat transcripts belong to a separate Pi Durable namespace in the Studio database. */

const os = require('node:os');
const { serializeMessage } = require('../core/serialize.cjs');
const { databasePath, getStudioDatabase } = require('../core/studio-db.cjs');
const { getTemporaryHarnessProfile } = require('../core/app-settings.cjs');
const { getStudioModelsRuntime, getStudioModelsRuntimeSync } = require('../core/studio-models.cjs');
const {
  modelInfoFor,
  runtimeModelFor,
  splitModelRef,
} = require('./models.cjs');
const { getDurableRuntime, sanitizedShellEnv } = require('../runtime/durable-runtime.cjs');
const { openDurableStorage } = require('../runtime/durable-storage.cjs');
const durableView = require('../runtime/view.cjs');
const { releaseProviderSession } = require('../runtime/provider-session.cjs');
const { temporarySafeExtensions } = require('./studio-extensions.cjs');
const { temporaryRuntimeSelection } = require('../runtime/tool-selection.cjs');
const { evaluateTemporaryToolCall } = require('../capabilities/permissions/index.cjs');
const { requestPolicyConfirmation } = require('./confirmations.cjs');
const { redactToolSecrets, resolveToolSecrets } = require('./secret-vault.cjs');
const { CODING_RULES, toolGuidance } = require('../capabilities/harness/index.cjs');

const chats = new Map();
let temporaryRuntime;
let temporaryOpening;

function buildDefaultInstructions(hasTools) {
  return [
    'You are Pi in a temporary chat inside Pi Studio.',
    hasTools
      ? 'Answer directly in the user language. No workspace files are attached, but read-only user plugin tools are available when helpful.'
      : 'Answer directly in the user language. No workspace is attached and no tools are available.',
    'This conversation and its images are saved in local temporary chat history, separately from workspace conversations.',
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
  parts.push('This conversation and its images are saved in local temporary chat history, separately from workspace conversations.');
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
  if (!durableRuntime?.registry) {
    return syncTemporarySafeExtensions(runtime);
  }
  const selection = await temporaryRuntimeSelection();
  const harnessProfile = getTemporaryHarnessProfile();
  const permissionExt = selection.tools.length > 0
    ? (runtime.permissionExtension ??= createTemporaryPermissionsExtension(runtime.durable))
    : undefined;
  const extensions = selection.extensions.map(extension => {
    if (extension.name !== 'studio-browser-tools') return extension;
    // Temporary Durable IDs belong to a separate store and may collide with project conversation IDs.
    return runtime.browserTools ??= require('../capabilities/browser/index.cjs').createBrowserTools(runtime.durable, { temporary: true });
  });
  const installedExtensions = syncExtensionEntries(
    runtime,
    extensions,
    permissionExt,
  );
  const browserTools = new Map(runtime.browserTools?.tools?.map(tool => [tool.name, tool]));
  const tools = selection.tools.map(tool => browserTools.get(tool.name) || tool);
  const instructions = buildHarnessInstructions(tools, harnessProfile);
  const signature = JSON.stringify({
    profileId: selection.profile.id,
    tools: selection.tools.map((tool) => tool.name),
    extensions: installedExtensions.map((ext) => ext.name),
    instructions,
  });
  return {
    extensions: installedExtensions,
    tools,
    instructions,
    signature,
  };
}

async function openTemporaryRuntime() {
  if (temporaryRuntime) return temporaryRuntime;
  if (temporaryOpening) return temporaryOpening;
  temporaryOpening = (async () => {
    const durableRuntime = await getDurableRuntime();
    const studioModels = await getStudioModelsRuntime();
    getStudioDatabase();
    const storage = await openDurableStorage(databasePath(), {
      prefix: 'pi_temporary_',
      busyTimeoutMs: 15_000,
    });
    const registry = durableRuntime.durable.createRegistry();
    let envFactory;
    if (durableRuntime.registry) {
      try {
        const durableEnv = await import('@earendil-works/pi-durable/env/node');
        envFactory = ({ cwd }) => new durableEnv.NodeExecutionEnv({
          cwd: cwd || os.tmpdir(),
          shellEnv: sanitizedShellEnv(),
        });
      } catch {
        envFactory = undefined;
      }
    }
    const harness = await durableRuntime.durable.Harness.open(storage, {
      models: () => (getStudioModelsRuntimeSync() || studioModels).models,
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
    }, durableRuntime.context).catch(async error => {
      await storage.close().catch(() => {});
      throw error;
    });
    temporaryRuntime = {
      durable: durableRuntime.durable,
      context: durableRuntime.context,
      cleanupSessionResources: durableRuntime.cleanupSessionResources,
      durableRuntime,
      stopKeepAwake: durableRuntime.keepAwake?.addHarness(harness, durableRuntime.context),
      harness,
      registry,
      storage,
    };
    return temporaryRuntime;
  })().finally(() => {
    temporaryOpening = undefined;
  });
  return temporaryOpening;
}

async function closeTemporaryRuntime() {
  if (temporaryOpening) await temporaryOpening.catch(() => {});
  const current = temporaryRuntime;
  temporaryRuntime = undefined;
  if (!current) return;
  current.stopKeepAwake?.();
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

function entryMessages(record) {
  if (!['pi.user', 'pi.assistant', 'pi.tool-result'].includes(record.kind)) return [];
  return (record.model || []).map(serializeMessage).filter(Boolean);
}

function temporaryHistory() {
  return getStudioDatabase().listTemporaryChats();
}

async function temporaryRead(id) {
  if (typeof id !== 'string') return null;
  const saved = getStudioDatabase().getTemporaryChat(id);
  if (!saved) return null;
  const { durableId, hasImages, ...summary } = saved;
  const runtime = await openTemporaryRuntime();
  const conversation = await runtime.harness.conversation(durableId, runtime.context);
  if (!conversation) throw new Error('未找到这段临时对话的本地记录');
  const messages = [];
  let cursor;
  do {
    const page = await conversation.entries({ order: 'ascending' }, 100, cursor, runtime.context);
    for (const record of page.items) messages.push(...entryMessages(record));
    cursor = page.next;
  } while (cursor);
  return { ...summary, messages };
}

async function watchConversation(entry) {
  const watch = await entry.conversation.watch(entry.runtime.context);
  entry.stream = watch;
  let previous = durableView.liveFromView(watch.value);
  const entryIds = durableView.seedEntryIds(watch.value.entries);
  watch.start(async (call) => {
    if (call.kind !== 'value') return;
    const live = durableView.liveFromView(call.value);
    for (const record of durableView.appendedEntries(entryIds, call.value.entries)) {
      for (const message of entryMessages(record)) entry.send({ type: 'message', message });
    }
    const streamed = live.generation?.message;
    if (streamed && streamed !== previous.generation?.message) {
      const message = serializeMessage(streamed);
      if (message) entry.send({ type: 'message', message: { ...message, streaming: true } });
    }
    if (live.runFailure && live.runFailure !== previous.runFailure) {
      entry.send({
        type: 'error',
        message: live.runFailure.detail || live.runFailure.reason || '临时回复未完成',
      });
    }
    previous = live;
  });
}

async function submitTemporary(entry, payload, input) {
  const { model, selection } = await resolveModel(payload.modelRef, payload.thinkingLevel);
  const acceptsImages = Array.isArray(model.input) && model.input.includes('image');
  if (input.images.length && !acceptsImages) {
    throw new Error('当前模型不支持图片，请切换到支持图片的模型');
  }
  const db = getStudioDatabase();
  const saved = db.getTemporaryChat(payload.id);
  if (saved?.hasImages && !acceptsImages) {
    throw new Error('当前模型不支持图片，请切换到支持图片的模型');
  }
  if (entry.cancelled) throw new Error('消息发送已取消');
  const runtime = await openTemporaryRuntime();
  const safeTools = await resolveTemporaryCapabilities(runtime, runtime.durableRuntime);
  const agent = {
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: selection.effectiveThinkingLevel,
    ...(safeTools.signature !== entry.extensionSignature ? {
      extensions: safeTools.extensions,
      tools: safeTools.tools,
      instructions: safeTools.instructions,
    } : {}),
  };
  if (entry.cancelled) throw new Error('消息发送已取消');
  entry.runtime = runtime;
  if (saved || entry.conversation) {
    entry.conversation ??= await runtime.harness.conversation(saved.durableId, runtime.context);
    if (!entry.conversation) throw new Error('未找到这段临时对话的本地记录');
    await entry.conversation.configure(agent, runtime.context);
  } else {
    entry.conversation = await runtime.harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: { ...agent, cwd: os.tmpdir() },
    }, runtime.context);
  }
  entry.extensionSignature = safeTools.signature;
  if (!entry.stream) await watchConversation(entry);
  if (entry.cancelled) throw new Error('消息发送已取消');

  const hasImages = input.images.length > 0;
  // Save the public-id mapping before admitting work. A crash while the model is
  // running can then always be reopened through the temporary history index.
  if (!saved) db.createTemporaryChat({
    id: payload.id,
    durableId: entry.conversation.id,
    title: Array.from(input.text.replace(/\s+/g, ' ') || '图片对话').slice(0, 60).join(''),
    modelRef: selection.modelRef,
    thinkingLevel: selection.thinkingLevel,
    hasImages,
  });
  const requestId = crypto.randomUUID();
  let submission;
  try {
    submission = await entry.conversation.submit({
      type: 'input',
      content: content(input),
      requestId,
    }, runtime.context);
  } catch (error) {
    // On an ambiguous storage failure keep the mapping. Remove it only when
    // Durable confirms the first input was never committed.
    if (!saved) {
      const admitted = await runtime.storage.submissionByRequest(entry.conversation.id, requestId, runtime.context)
        .catch(() => true);
      if (!admitted) {
        db.removeTemporaryChatIndex(payload.id, entry.conversation.id);
        require('./tool-window.cjs').forgetToolWindowOwners(['temporary:' + payload.id]);
      }
    }
    throw error;
  }
  db.touchTemporaryChat(payload.id, selection.modelRef, selection.thinkingLevel, hasImages);
  if (entry.cancelled) await entry.conversation.abort(runtime.context);
  const settled = await submission.wait(runtime.context);
  if (settled.status === 'unanswered' && !entry.cancelled) {
    throw new Error(settled.reason || '临时回复未完成');
  }
}

async function temporaryPrompt(owner, payload, send) {
  const input = validateInput(payload);
  const id = payload.id;
  const entry = chats.get(id) || {};
  if (entry.pending || entry.closing) {
    throw new Error('请等待当前回复完成，或先停止回复');
  }
  entry.owner = owner;
  entry.send = send;
  entry.cancelled = false;
  chats.set(id, entry);
  entry.pending = submitTemporary(entry, payload, input);
  try {
    await entry.pending;
  } finally {
    entry.pending = undefined;
    if (!entry.conversation && !entry.closing) chats.delete(id);
    send({ type: 'done' });
  }
}

async function stopTemporary(owner, id) {
  const entry = chats.get(id);
  if (entry?.owner !== owner) return;
  entry.cancelled = true;
  await entry.conversation?.abort(entry.runtime.context).catch(() => {});
}

async function closeTemporary(owner, id) {
  const entry = chats.get(id);
  if (entry?.owner !== owner) return;
  entry.closing ??= (async () => {
    await stopTemporary(owner, id);
    await entry.pending?.catch(() => {});
    await entry.stream?.stop().catch(() => {});
    if (entry.conversation) await releaseProviderSession(entry.runtime, entry.conversation.id);
    chats.delete(id);
  })();
  await entry.closing;
}

async function closeOwner(owner) {
  await Promise.all([...chats].filter(([, entry]) => entry.owner === owner)
    .map(([id]) => closeTemporary(owner, id)));
}

async function shutdownTemporaryChats() {
  await Promise.all([...chats].map(([id, entry]) => closeTemporary(entry.owner, id)));
  await closeTemporaryRuntime();
}

module.exports = {
  closeOwner,
  closeTemporary,
  shutdownTemporaryChats,
  stopTemporary,
  temporaryHistory,
  temporaryRead,
  temporaryModel,
  temporaryPrompt,
  validateInput,
};
