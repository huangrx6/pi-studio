const { getStudioDatabase } = require('../core/studio-db.cjs');
const { withProviderCredentialLock } = require('../core/studio-models.cjs');
const { mediaKinds } = require('../core/media-model-config.cjs');

function listMediaModels() {
  const result = { speech: [], image: [] };
  for (const provider of getStudioDatabase().listProviders()) {
    if (!provider.enabled) continue;
    for (const kind of mediaKinds) {
      for (const modelId of provider.mediaModels[kind]) {
        result[kind].push({ providerId: provider.id, modelId, label: `${provider.name} · ${modelId}` });
      }
    }
  }
  return result;
}

async function resolveMediaModel(kind, providerId, modelId) {
  if (!mediaKinds.includes(kind) || typeof providerId !== 'string' || typeof modelId !== 'string') {
    throw new Error('请选择已配置的语音或生图模型。');
  }
  // Read the endpoint and key together with provider edits; the renderer may only supply IDs.
  return withProviderCredentialLock(providerId, async () => {
    const db = getStudioDatabase();
    const provider = db.getProvider(providerId);
    if (!provider?.enabled || !provider.mediaModels[kind].includes(modelId)) {
      throw new Error('所选模型已移除或来源已停用，请重新选择。');
    }
    let credential;
    try { credential = await db.readCredentialAsync(providerId); }
    catch { throw new Error('无法读取此来源的 API Key，请检查模型配置。'); }
    if (credential && credential.type !== 'api_key') throw new Error('此来源的媒体接口需要 API Key 认证。');
    if (!db.getProvider(providerId)?.enabled) throw new Error('模型来源已停用，请重新选择。');
    return { baseUrl: provider.baseUrl, modelId, apiKey: credential?.key || '' };
  });
}

module.exports = { listMediaModels, resolveMediaModel };
