const mediaKinds = ['speech', 'image'];

function normalizeMediaModels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('媒体模型配置无效。');
  return Object.fromEntries(mediaKinds.map(kind => {
    if (!Array.isArray(value[kind])) throw new Error('请分别填写语音和生图模型 ID。');
    const ids = value[kind].map(id => {
      if (typeof id !== 'string' || /[\s\u0000-\u001f\u007f]/u.test(id.trim())) throw new Error('模型 ID 不能包含空格或控制字符。');
      return id.trim();
    });
    return [kind, [...new Set(ids.filter(Boolean))]];
  }));
}

function isMediaModel(provider, modelId) {
  return mediaKinds.some(kind => provider?.mediaModels?.[kind]?.includes(modelId));
}

module.exports = { isMediaModel, normalizeMediaModels };
