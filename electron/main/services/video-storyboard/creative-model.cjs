const { addMaterialReferences } = require('./director-materials.cjs');

const timeoutMs = 180_000;

async function configuredWriter(modelRef) {
  const { getStudioModelsRuntime } = require('../../core/studio-models.cjs');
  const { enabledRuntimeModel, defaultModelRef } = require('../models.cjs');
  const { models } = await getStudioModelsRuntime();
  const ref = modelRef ?? defaultModelRef(models);
  const model = enabledRuntimeModel(models, ref);
  if (!model) throw new Error('请选择已启用的文本模型，可在模型设置中添加');
  return { modelRef: ref, model, complete: (context, options) => models.completeSimple(model, context, options) };
}

function providerError(message) {
  if (/\b(401|403)\b|unauthorized|api.?key|credential|forbidden|no auth/i.test(message)) return '模型认证或权限不足，请检查所选模型的凭据';
  if (/\b402\b|insufficient.balance/i.test(message)) return '所选模型的账户余额不足';
  if (/\b429\b|rate.?limit|quota/i.test(message)) return '模型服务的额度或请求频率受限，请稍后重试';
  if (/time.?out|timed out|abort/i.test(message)) return '模型回复超时，请缩短要求或重试';
  if (/context.?length|context.?window|too many tokens/i.test(message)) return '创作资料超过模型上下文，请使用更大上下文的模型';
  if (/image_url|image input|support.*image|multimodal/i.test(message)) return '模型服务未接受图片输入，请检查该模型的看图能力，或选择纯文本模型';
  if (/model[_ ]not[_ ]found|model.*does not exist|\b404\b/i.test(message)) return '模型服务找不到此模型，请检查来源地址和模型 ID';
  if (/fetch failed|connection error|econn|enotfound|network/i.test(message)) return '无法连接所选模型的服务，请检查网络或来源地址';
  const httpStatus = message.match(/\b([45]\d\d)\b/)?.[1];
  if (httpStatus) return `创作模型服务返回 HTTP ${httpStatus}，请核对模型配置或稍后重试`;
  return '创作模型调用失败，请检查模型配置与网络后重试';
}

async function requestCreativeJson({ brief, modelRef, systemPrompt, tokenLimit, invalidResponse }, options) {
  if (modelRef != null && (typeof modelRef !== 'string' || modelRef.length > 256 || !modelRef.includes('/'))) {
    throw new Error('请选择已配置的文本模型');
  }
  const writer = await (options.resolveWriter ?? configuredWriter)(modelRef);
  const images = await addMaterialReferences(brief.assets, {
    sourceFor: options.sourceFor, supportsImages: writer.model.input?.includes('image'), thumbnail: options.thumbnail,
  });
  const text = JSON.stringify(brief);
  if (text.length > 120_000) throw new Error('当前资料超过一次模型请求的长度。请缩短讨论或减少本次使用的素材');
  const signal = AbortSignal.timeout(timeoutMs);
  let message;
  try {
    message = await writer.complete({ systemPrompt, messages: [{ role: 'user',
      content: [{ type: 'text', text }, ...images], timestamp: Date.now() }] }, {
      maxTokens: Math.min(writer.model.maxTokens || 8192, tokenLimit),
      signal, timeoutMs, maxRetries: 0,
    });
  } catch (error) {
    throw new Error(providerError(signal.aborted ? 'timeout' : error?.message ?? ''));
  }
  if (message?.stopReason === 'length') throw new Error('模型回复达到长度上限，请缩短要求或切换模型');
  if (!message || message.errorMessage || ['error', 'aborted'].includes(message.stopReason)) {
    throw new Error(providerError(message?.errorMessage ?? message?.stopReason ?? ''));
  }
  const reply = (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(reply);
  try {
    return { modelRef: writer.modelRef, result: JSON.parse(fence ? fence[1] : reply) };
  } catch {
    throw new Error(invalidResponse);
  }
}

module.exports = { requestCreativeJson };
