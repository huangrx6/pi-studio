/** Temporary chats own only RAM state. No session index, attachments directory or project loader. */
const os = require('node:os');
const { piModule, getRuntime, getModelRef, agentDir } = require('../core/state.cjs');
const { modelInfoFor } = require('./models.cjs');
const { serializeMessage } = require('../core/serialize.cjs');
const chats = new Map();

async function resolveModel(modelRef, thinkingLevel) {
  const runtime = await getRuntime();
  const [provider, ...parts] = (modelRef || getModelRef()).split('/');
  const model = runtime.getModel(provider, parts.join('/'));
  if (!model) throw new Error('请选择一个已配置的模型');
  const base = modelInfoFor(model, os.tmpdir());
  const level = thinkingLevel && base.thinkingLevels.includes(thinkingLevel) ? thinkingLevel : base.thinkingLevel;
  return { runtime, model, selection: { ...base, thinkingLevel: level, effectiveThinkingLevel: level === 'default' ? base.defaultThinkingLevel : level } };
}
async function temporaryModel(payload) { return (await resolveModel(payload?.modelRef, payload?.thinkingLevel)).selection; }

function validateInput(payload) {
  if (typeof payload?.id !== 'string' || !/^[\w-]{1,100}$/.test(payload.id)) throw new Error('临时聊天标识无效');
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const images = payload.images ?? [];
  if (!Array.isArray(images) || images.length > 8) throw new Error('最多上传 8 张图片');
  if (text.length > 100000) throw new Error('消息过长，请缩短后发送');
  let total = 0;
  for (const image of images) {
    if (!image || !['image/png','image/jpeg','image/webp','image/gif'].includes(image.mimeType) || typeof image.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error('图片格式无效');
    total += image.data.length;
    if (!image.data || image.data.length > 14_000_000 || total > 40_000_000) throw new Error('图片过大，请压缩后重试');
  }
  if (!text && !images.length) throw new Error('请输入消息或添加图片');
  return { text, images: images.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType })) };
}
async function temporaryPrompt(owner, payload, send) {
  const input = validateInput(payload);
  const key = `${owner}:${payload.id}`;
  let entry = chats.get(key);
  if (entry?.busy) throw new Error('请等待当前回复完成，或先停止回复');
  if (!entry) { entry = { busy: false, cancelled: false, session: null }; chats.set(key, entry); }
  entry.busy = true; entry.cancelled = false; entry.stopped = false;
  let unsubscribe, updateTimer, pending;
  const flush = () => { clearTimeout(updateTimer); updateTimer = undefined; if (pending) { send({ type: 'message', message: pending }); pending = undefined; } };
  try {
    const { runtime, model, selection } = await resolveModel(payload.modelRef, payload.thinkingLevel);
    if ((input.images.length || entry.session?.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'))) && !model.input?.includes('image')) throw new Error('当前模型不支持图片，请切换到支持图片的模型');
    if (entry.cancelled || entry.stopped) return;
    if (!entry.session) {
      const pi = piModule(), cwd = os.tmpdir();
      const settingsManager = pi.SettingsManager.inMemory({ cacheWarming: 'off' });
      const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir: agentDir(), settingsManager,
        noExtensions: true, disabledBuiltinExtensions: ['mcp'], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: 'You are Pi, a helpful assistant in a temporary chat. Answer the user directly in their language. You have no workspace or file tools. The messages and uploaded images in this chat are held in application memory and are not saved as local chat history.',
      });
      await resourceLoader.reload();
      if (entry.cancelled || entry.stopped) return;
      const result = await pi.createAgentSession({ cwd, model, modelRuntime: runtime, thinkingLevel: selection.effectiveThinkingLevel,
        tools: [], noTools: 'all', sessionManager: pi.SessionManager.inMemory(cwd), settingsManager, resourceLoader });
      entry.session = result.session;
    } else {
      await entry.session.setModel(model);
      entry.session.setThinkingLevel(selection.effectiveThinkingLevel);
    }
    if (entry.cancelled || entry.stopped) { if (entry.cancelled) entry.session.dispose(); return; }
    unsubscribe = entry.session.subscribe(event => {
      if (!['message_start','message_update','message_end'].includes(event.type)) return;
      const message = serializeMessage(event.message); if (!message) return;
      if (event.type === 'message_update') { pending = message; if (!updateTimer) updateTimer = setTimeout(flush, 32); }
      else { flush(); send({ type: 'message', message }); }
    });
    await entry.session.prompt(input.text || '请描述这张图片。', { images: input.images });
  } finally {
    flush(); unsubscribe?.(); entry.busy = false;
    send({ type: 'done' });
    if (entry.cancelled) { entry.session?.dispose(); if (chats.get(key) === entry) chats.delete(key); }
  }
}
async function stopTemporary(owner, id) {
  const entry = chats.get(`${owner}:${id}`);
  if (!entry) return;
  entry.stopped = true;
  await entry.session?.abort();
}
async function closeTemporary(owner, id) {
  const key = `${owner}:${id}`, entry = chats.get(key);
  if (!entry) return;
  chats.delete(key); entry.cancelled = true;
  await entry.session?.abort(); entry.session?.dispose();
}
function closeOwner(owner) { for (const key of chats.keys()) if (key.startsWith(`${owner}:`)) void closeTemporary(owner, key.slice(String(owner).length+1)); }
module.exports = { temporaryModel, temporaryPrompt, stopTemporary, closeTemporary, closeOwner, validateInput };
