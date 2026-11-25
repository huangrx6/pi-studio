const { builtinToolContributions } = require('../../core/builtin-tool-contributions.cjs');

module.exports = Object.freeze([
  {
    id: 'studio-desktop-control',
    tier: 'system',
    name: 'Studio 电脑操控',
    version: '0.1.0',
    description: '在 macOS 上观察已允许应用的窗口，并支持受限点击、输入、滚动、拖拽与快捷键（默认关闭）。',
    runtimeName: 'studio-desktop-control',
    runtimeNames: ['studio-desktop-control'],
    permissions: ['agent.tools'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: builtinToolContributions([
        'desktop_status', 'desktop_apps', 'desktop_windows', 'desktop_snapshot', 'desktop_screenshot',
        'desktop_click', 'desktop_type', 'desktop_scroll', 'desktop_drag', 'desktop_hotkey',
      ]),
    },
  },
]);
