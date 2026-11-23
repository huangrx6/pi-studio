/**
 * Agent tools for the in-app browser (Phase 2–4: read, act, highlight, optional evaluate).
 */
const toolSchema = require('../../runtime/tool-schema.cjs');
const {
  assertBrowserAgentControlEnabled,
  assertSiteActionAllowed,
  attachExternalChromeTarget,
  captureBrowserScreenshot,
  captureBrowserSnapshot,
  clearBrowserHighlights,
  clickBrowserRef,
  controlBrowserTab,
  detachExternalChrome,
  evaluateBrowserScript,
  evaluateExternalChrome,
  getBrowserPreferences,
  handleBrowserDialog,
  highlightBrowserRef,
  isBrowserEvaluateEnabled,
  listBrowserDialogs,
  listBrowserDownloads,
  listBrowserTabs,
  listExternalChromeSessions,
  listExternalChromeTargets,
  navigateBrowserTab,
  navigateExternalChrome,
  requestFocusBrowserTab,
  requestOpenBrowserTab,
  resolveBrowserTab,
  scrollBrowser,
  selectBrowserRef,
  sendBrowserCdp,
  sendExternalChromeCdp,
  typeBrowserRef,
  waitBrowser,
} = require('../../services/browser/index.cjs');

function textResult(text, details) {
  const payload = { output: [{ type: 'text', text: String(text || '') }] };
  if (details !== undefined) payload.details = details;
  return payload;
}

function formatTabs(tabs) {
  if (!tabs.length) return '当前没有打开的浏览器标签。';
  return tabs.map((tab) => {
    const mark = tab.active ? '*' : ' ';
    const title = tab.title || tab.url || tab.id;
    return `${mark} ${tab.id}  ${title}  ${tab.url || ''}`.trimEnd();
  }).join('\n');
}

function ensureAgentBrowser() {
  assertBrowserAgentControlEnabled();
}

function createBrowserTools(durable) {
  const { defineExtension, defineTool } = durable;
  const Type = toolSchema;

  const browserTabs = defineTool({
    name: 'browser_tabs',
    description: 'List or focus tabs in the Studio workbench browser.',
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: 'list (default) or focus' })),
      tabId: Type.Optional(Type.String({ description: 'Tab id when action is focus' })),
    }),
    replay: 'safe',
    async execute(args) {
      ensureAgentBrowser();
      const action = String(args.action || 'list').toLowerCase();
      if (action === 'focus') {
        if (!args.tabId) throw new Error('聚焦标签需要 tabId');
        const tab = await requestFocusBrowserTab(args.tabId);
        return textResult(`已聚焦：${tab.title || tab.url || tab.id}`, { tab, tabs: listBrowserTabs() });
      }
      if (action !== 'list') throw new Error(`不支持的 action：${args.action}`);
      const tabs = listBrowserTabs();
      return textResult(formatTabs(tabs), { tabs });
    },
  });

  const browserOpen = defineTool({
    name: 'browser_open',
    description: 'Open a URL in the Studio workbench browser (creates or reuses a tab).',
    parameters: Type.Object({
      url: Type.String({ description: 'http(s) URL, local HTML file URL, or about:blank' }),
      newTab: Type.Optional(Type.Boolean({ description: 'Force a new tab even if URL is already open' })),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const url = String(args.url || '').trim();
      if (!url) throw new Error('url 不能为空');
      assertSiteActionAllowed(url, 'navigate');
      const tab = await requestOpenBrowserTab(url, { newTab: args.newTab === true });
      return textResult(`已打开：${tab.url || url}`, { tab, tabs: listBrowserTabs() });
    },
  });

  const browserNavigate = defineTool({
    name: 'browser_navigate',
    description: 'Navigate the active (or specified) browser tab: load a URL, go back/forward, or reload.',
    parameters: Type.Object({
      tabId: Type.Optional(Type.String({ description: 'Target tab id; defaults to the active tab' })),
      url: Type.Optional(Type.String({ description: 'URL to load' })),
      action: Type.Optional(Type.String({ description: 'back | forward | reload when not loading a URL' })),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const tabId = args.tabId ? String(args.tabId) : undefined;
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
      let tab;
      if (url) {
        assertSiteActionAllowed(url, 'navigate');
        tab = await navigateBrowserTab(tabId, url);
      } else if (action) {
        const current = resolveBrowserTab(tabId);
        assertSiteActionAllowed(current.url, 'navigate');
        tab = await controlBrowserTab(tabId, action);
      }
      else throw new Error('请提供 url，或 action（back/forward/reload）');
      return textResult(`${tab.title || ''} ${tab.url || ''}`.trim(), { tab });
    },
  });

  const browserSnapshot = defineTool({
    name: 'browser_snapshot',
    description: 'Capture a bounded structural snapshot of the current browser page. Elements get ref ids for later click/type. mode=a11y emphasizes roles/names; same-origin iframes are included when possible.',
    parameters: Type.Object({
      tabId: Type.Optional(Type.String({ description: 'Target tab id; defaults to the active tab' })),
      mode: Type.Optional(Type.String({ description: 'dom_lite (default) or a11y' })),
      maxChars: Type.Optional(Type.Number({ minimum: 2000, maximum: 40000, description: 'Soft size budget for the JSON snapshot' })),
      includeIframes: Type.Optional(Type.Boolean({ description: 'Walk same-origin iframes (default true)' })),
    }),
    replay: 'safe',
    async execute(args) {
      ensureAgentBrowser();
      const entry = resolveBrowserTab(args.tabId);
      assertSiteActionAllowed(entry.url, 'read');
      const contents = getTabWebContents(entry);
      if (!contents) throw new Error('浏览器标签尚未就绪，请先 browser_open 或等待页面加载');
      const snapshot = await captureBrowserSnapshot(contents, {
        maxChars: args.maxChars,
        mode: args.mode,
        includeIframes: args.includeIframes,
      });
      const details = {
        tabId: entry.id,
        url: snapshot.url,
        title: snapshot.title,
        mode: snapshot.mode,
        truncated: snapshot.truncated,
        omittedCount: snapshot.omittedCount,
        stampedCount: snapshot.stampedCount,
        nodeCount: Object.keys(snapshot.refs || {}).length,
        refs: snapshot.refs,
        tree: snapshot.tree,
        warnings: snapshot.warnings,
      };
      const summary = [
        `url: ${snapshot.url || entry.url || ''}`,
        `title: ${snapshot.title || entry.title || ''}`,
        `mode: ${snapshot.mode || 'dom_lite'}`,
        `nodes: ${details.nodeCount}${snapshot.truncated ? ' (truncated)' : ''}`,
        snapshot.warnings?.length ? `warnings: ${snapshot.warnings.join('; ')}` : '',
        JSON.stringify({ refs: snapshot.refs, tree: snapshot.tree }, null, 2),
      ].filter(Boolean).join('\n');
      return textResult(summary, details);
    },
  });

  const browserScreenshot = defineTool({
    name: 'browser_screenshot',
    description: 'Capture a JPEG screenshot of the current browser viewport.',
    parameters: Type.Object({
      tabId: Type.Optional(Type.String({ description: 'Target tab id; defaults to the active tab' })),
    }),
    replay: 'safe',
    async execute(args) {
      ensureAgentBrowser();
      const entry = resolveBrowserTab(args.tabId);
      assertSiteActionAllowed(entry.url, 'read');
      const contents = getTabWebContents(entry);
      if (!contents) throw new Error('浏览器标签尚未就绪，请先 browser_open 或等待页面加载');
      const shot = await captureBrowserScreenshot(contents);
      const label = `${entry.title || entry.url || entry.id} (${shot.width}×${shot.height})`;
      return {
        output: [
          { type: 'text', text: `截图：${label}` },
          { type: 'image', mimeType: shot.mimeType, data: shot.data },
        ],
        details: {
          tabId: entry.id,
          url: entry.url,
          title: entry.title,
          width: shot.width,
          height: shot.height,
        },
      };
    },
  });

  const browserClick = defineTool({
    name: 'browser_click',
    description: 'Click an element from the latest browser_snapshot by ref.',
    parameters: Type.Object({
      ref: Type.String({ description: 'Element ref from browser_snapshot (e.g. e12)' }),
      tabId: Type.Optional(Type.String()),
      snapshot: Type.Optional(Type.Boolean({ description: 'Include a compact follow-up snapshot summary (default true)' })),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const result = await clickBrowserRef(args.tabId, args.ref, { snapshot: args.snapshot });
      return textResult(`已点击 ${args.ref}（${result.element?.name || result.element?.tag || ''}）`, result);
    },
  });

  const browserType = defineTool({
    name: 'browser_type',
    description: 'Type text into an element from browser_snapshot by ref.',
    parameters: Type.Object({
      ref: Type.String({ description: 'Element ref from browser_snapshot' }),
      text: Type.String({ description: 'Text to type' }),
      tabId: Type.Optional(Type.String()),
      clear: Type.Optional(Type.Boolean({ description: 'Clear existing value first (default true)' })),
      submit: Type.Optional(Type.Boolean({ description: 'Press Enter / submit form after typing' })),
      snapshot: Type.Optional(Type.Boolean()),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const result = await typeBrowserRef(args.tabId, args.ref, args.text, {
        clear: args.clear,
        submit: args.submit,
        snapshot: args.snapshot,
      });
      return textResult(`已输入到 ${args.ref}`, result);
    },
  });

  const browserScroll = defineTool({
    name: 'browser_scroll',
    description: 'Scroll the page or scroll an element into view.',
    parameters: Type.Object({
      tabId: Type.Optional(Type.String()),
      ref: Type.Optional(Type.String({ description: 'If set, scroll this ref into view' })),
      direction: Type.Optional(Type.String({ description: 'down | up | left | right' })),
      amount: Type.Optional(Type.Number({ minimum: 1, maximum: 4000 })),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const result = await scrollBrowser(args.tabId, args);
      return textResult(result.mode === 'ref' ? `已滚到 ${args.ref}` : `已滚动 ${args.direction || 'down'}`, result);
    },
  });

  const browserWait = defineTool({
    name: 'browser_wait',
    description: 'Wait until a ref appears, URL contains text, or page text matches.',
    parameters: Type.Object({
      tabId: Type.Optional(Type.String()),
      ref: Type.Optional(Type.String()),
      urlIncludes: Type.Optional(Type.String()),
      textIncludes: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 60000 })),
    }),
    replay: 'safe',
    async execute(args) {
      ensureAgentBrowser();
      if (!args.ref && !args.urlIncludes && !args.textIncludes) {
        throw new Error('请提供 ref、urlIncludes 或 textIncludes');
      }
      const result = await waitBrowser(args.tabId, args);
      return textResult(`等待完成（${result.waitedMs}ms） ${result.url || ''}`.trim(), result);
    },
  });

  const browserSelect = defineTool({
    name: 'browser_select',
    description: 'Select option(s) on a <select> element by ref.',
    parameters: Type.Object({
      ref: Type.String(),
      values: Type.Array(Type.String(), { description: 'Option values or visible labels' }),
      tabId: Type.Optional(Type.String()),
      snapshot: Type.Optional(Type.Boolean()),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const result = await selectBrowserRef(args.tabId, args.ref, args.values, { snapshot: args.snapshot });
      return textResult(`已选择 ${result.selected?.join(', ') || ''}`, result);
    },
  });

  const browserDialog = defineTool({
    name: 'browser_dialog',
    description: 'Prepare the next alert/confirm/prompt response, or list recent dialogs.',
    parameters: Type.Object({
      tabId: Type.Optional(Type.String()),
      action: Type.Optional(Type.String({ description: 'handle (default) | list' })),
      accept: Type.Optional(Type.Boolean({ description: 'Accept confirm/prompt (default true)' })),
      promptText: Type.Optional(Type.String({ description: 'Text for prompt dialogs' })),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const action = String(args.action || 'handle').toLowerCase();
      if (action === 'list') {
        const result = await listBrowserDialogs(args.tabId);
        return textResult(JSON.stringify(result.pending || [], null, 2) || '无对话框', result);
      }
      const result = await handleBrowserDialog(args.tabId, {
        accept: args.accept,
        promptText: args.promptText,
      });
      return textResult(`已设置下一次对话框响应（accept=${result.accept}）`, result);
    },
  });


  const browserHighlight = defineTool({
    name: 'browser_highlight',
    description: 'Highlight or clear the on-page outline for a snapshot ref so the user can see the Agent target.',
    parameters: Type.Object({
      tabId: Type.Optional(Type.String()),
      ref: Type.Optional(Type.String({ description: 'Element ref from browser_snapshot' })),
      label: Type.Optional(Type.String({ description: 'Optional badge label' })),
      clear: Type.Optional(Type.Boolean({ description: 'Clear highlights when true' })),
    }),
    replay: 'safe',
    async execute(args) {
      ensureAgentBrowser();
      if (args.clear === true || !args.ref) {
        const result = await clearBrowserHighlights(args.tabId);
        return textResult('已清除页面标注', result);
      }
      if (getBrowserPreferences().annotatedScreenshots === 'never') {
        return textResult('批注截图已在设置中关闭', { skipped: true });
      }
      const result = await highlightBrowserRef(args.tabId, args.ref, { label: args.label });
      return textResult(`已高亮 ${args.ref}`, result);
    },
  });

  const browserEvaluate = defineTool({
    name: 'browser_evaluate',
    description: 'Run a JavaScript expression in the page. Disabled by default; requires advanced setting and site evaluate allow.',
    parameters: Type.Object({
      expression: Type.String({ description: 'JavaScript expression to evaluate in the page context' }),
      tabId: Type.Optional(Type.String()),
      note: Type.Optional(Type.String({ description: 'Short reason shown in audit/UI' })),
    }),
    async execute(args) {
      ensureAgentBrowser();
      if (!isBrowserEvaluateEnabled()) {
        throw new Error('页面脚本求值默认关闭。请先在设置 → 浏览器中开启，并为当前站点允许 evaluate。');
      }
      const result = await evaluateBrowserScript(args.tabId, args.expression, { note: args.note });
      return textResult(String(result.preview ?? ''), result);
    },
  });

  const browserDownload = defineTool({
    name: 'browser_download',
    description: 'List recent in-app browser downloads (metadata only).',
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: 'list (default)' })),
    }),
    replay: 'safe',
    async execute(args) {
      ensureAgentBrowser();
      const action = String(args.action || 'list').toLowerCase();
      if (action !== 'list') throw new Error(`暂不支持 action：${args.action}`);
      const downloads = listBrowserDownloads().slice(0, 30).map((item) => ({
        id: item.id,
        filename: item.filename,
        state: item.state,
        url: item.url,
        risky: item.risky,
        receivedBytes: item.receivedBytes,
        totalBytes: item.totalBytes,
      }));
      const lines = downloads.map((item) => `${item.state}  ${item.filename}  ${item.url}`).join('\n') || '暂无下载';
      return textResult(lines, { downloads });
    },
  });


  const browserCdp = defineTool({
    name: 'browser_cdp',
    description: 'Send a Chrome DevTools Protocol method to an in-app browser tab. Disabled by default; requires developer CDP setting and site cdp allow.',
    parameters: Type.Object({
      method: Type.String({ description: 'CDP method, e.g. Runtime.evaluate or Page.navigate' }),
      params: Type.Optional(Type.Object({}, { additionalProperties: true, description: 'CDP params object' })),
      tabId: Type.Optional(Type.String()),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const result = await sendBrowserCdp(args.tabId, args.method, args.params || {});
      return textResult(JSON.stringify(result.result ?? result, null, 2).slice(0, 8000), result);
    },
  });

  const browserExternal = defineTool({
    name: 'browser_external',
    description: 'List, attach, drive, or detach a user-launched Chrome with remote debugging. Requires CDP + external Chrome settings. Never the default path.',
    parameters: Type.Object({
      action: Type.String({ description: 'list | attach | sessions | navigate | evaluate | cdp | detach' }),
      targetId: Type.Optional(Type.String({ description: 'Chrome target id for attach' })),
      sessionId: Type.Optional(Type.String({ description: 'Attached external session id' })),
      url: Type.Optional(Type.String()),
      expression: Type.Optional(Type.String()),
      method: Type.Optional(Type.String({ description: 'CDP method when action is cdp' })),
      params: Type.Optional(Type.Object({}, { additionalProperties: true })),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const action = String(args.action || 'list').toLowerCase();
      if (action === 'list') {
        const result = await listExternalChromeTargets();
        const lines = (result.targets || []).map((row) => `${row.id}  ${row.title || ''}  ${row.url || ''}`).join('\n') || '没有可连接的 page 目标';
        return textResult(`${result.warning || ''}\n${lines}`.trim(), result);
      }
      if (action === 'sessions') {
        const sessions = listExternalChromeSessions();
        const lines = sessions.map((row) => `${row.sessionId}  ${row.title || ''}  ${row.url || ''}`).join('\n') || '没有外接会话';
        return textResult(lines, { sessions });
      }
      if (action === 'attach') {
        if (!args.targetId) throw new Error('attach 需要 targetId（先 list）');
        const result = await attachExternalChromeTarget(args.targetId);
        return textResult(`已连接 ${result.session?.sessionId || ''}`, result);
      }
      if (action === 'detach') {
        const result = detachExternalChrome(args.sessionId);
        return textResult('已断开外接会话', result);
      }
      if (action === 'navigate') {
        if (!args.sessionId) throw new Error('navigate 需要 sessionId');
        if (!args.url) throw new Error('navigate 需要 url');
        const result = await navigateExternalChrome(args.sessionId, args.url);
        return textResult(`已导航 ${args.url}`, result);
      }
      if (action === 'evaluate') {
        if (!args.sessionId) throw new Error('evaluate 需要 sessionId');
        const result = await evaluateExternalChrome(args.sessionId, args.expression);
        return textResult(String(result.preview || ''), result);
      }
      if (action === 'cdp') {
        if (!args.sessionId) throw new Error('cdp 需要 sessionId');
        if (!args.method) throw new Error('cdp 需要 method');
        const result = await sendExternalChromeCdp(args.sessionId, args.method, args.params || {});
        return textResult(JSON.stringify(result.result ?? result, null, 2).slice(0, 8000), result);
      }
      throw new Error(`不支持的 action：${args.action}`);
    },
  });

  return defineExtension({
    name: 'studio-browser-tools',
    tools: [
      browserTabs,
      browserOpen,
      browserNavigate,
      browserSnapshot,
      browserScreenshot,
      browserClick,
      browserType,
      browserScroll,
      browserWait,
      browserSelect,
      browserDialog,
      browserDownload,
      browserHighlight,
      browserEvaluate,
      browserCdp,
      browserExternal,
    ],
  });
}

module.exports = {
  createBrowserTools,
};
