const { builtinToolContributions } = require('../../core/builtin-tool-contributions.cjs');

module.exports = Object.freeze([
  {
    id: 'studio-browser-tools',
    tier: 'system',
    name: 'Studio 浏览器',
    version: '1.3.0',
    description: '在工作台内嵌浏览器中打开、阅读并受控操作网页。',
    runtimeName: 'studio-browser-tools',
    runtimeNames: ['studio-browser-tools'],
    permissions: ['agent.tools'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: builtinToolContributions([
        'browser_tabs', 'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_screenshot',
        'browser_click', 'browser_type', 'browser_scroll', 'browser_wait', 'browser_select',
        'browser_dialog', 'browser_download', 'browser_highlight', 'browser_evaluate', 'browser_cdp', 'browser_external',
      ]),
    },
  },
]);
