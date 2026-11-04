module.exports = Object.freeze([
  {
    id: 'studio-image-fit',
    tier: 'system',
    name: 'Studio 请求图片适配',
    version: '1.0.0',
    description: '发送前把超出视觉接口限制的图片缩放到受支持的格式与尺寸，避免历史里的一张图让整段会话持续返回 400。',
    runtimeName: 'studio-image-fit',
    runtimeNames: ['studio-image-fit'],
    permissions: ['agent.hooks'],
    requires: [],
    contributes: {},
  },
]);
