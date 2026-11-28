const id = 'studio-keep-awake';
const title = '防止电脑休眠';

module.exports = Object.freeze([{
  id,
  name: title,
  tier: 'optional',
  version: '1.0.0',
  description: '让运行 Pi Studio 的电脑在远程访问或代理工作期间保持唤醒，屏幕仍可自动熄灭。',
  runtimeName: id,
  permissions: ['ui.panels', 'ui.data'],
  requires: [],
  contributes: {
    panels: [
      {
        id: 'chip', title, slot: 'status.chip', icon: 'coffee', size: 'compact',
        details: 'modes',
        content: [{ kind: 'dataView', sourceId: `builtin:${id}/summary` }],
      },
      {
        id: 'modes', title, slot: 'status.detail', icon: 'coffee', size: 'compact',
        view: { entry: 'ui/index.html', scope: 'global', sourceId: `builtin:${id}/control` },
      },
    ],
    dataSources: [
      { id: 'summary', title: '防休眠状态' },
      { id: 'control', title: '本机防休眠模式' },
    ],
  },
}]);
