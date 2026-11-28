/**
 * Agent tools for the in-app browser (Phase 2–4: read, act, highlight, optional evaluate).
 */
const toolSchema = require('../../runtime/tool-schema.cjs');
const {
  assertBrowserAgentControlEnabled,
  assertSiteActionAllowed,
  attachExternalChromeTarget,
  beginBrowserActivity,
  beginBrowserSession,
  captureBrowserScreenshot,
  captureBrowserSnapshot,
  clearBrowserHighlights,
  clickBrowserRef,
  controlBrowserTab,
  detachExternalChrome,
  dragBrowserRefs,
  endBrowserActivity,
  endBrowserSession,
  evaluateBrowserScript,
  evaluateExternalChrome,
  getBrowserPreferences,
  getElementRect,
  getTabWebContents,
  handleBrowserDialog,
  highlightBrowserRef,
  hoverBrowserRef,
  isBrowserEvaluateEnabled,
  listBrowserConsole,
  listBrowserDialogs,
  listBrowserDownloads,
  listBrowserNetwork,
  listBrowserTabs,
  listExternalChromeSessions,
  listExternalChromeTargets,
  navigateBrowserTab,
  navigateExternalChrome,
  browserPreferenceInstructions,
  pressBrowserKey,
  requestCloseBrowserTab,
  requestFocusBrowserTab,
  requestOpenBrowserTab,
  requestRevealBrowserTab,
  resolveBrowserOpenUrl,
  resolveBrowserTab,
  scrollBrowser,
  selectBrowserRef,
  sendBrowserCdp,
  sendExternalChromeCdp,
  setBrowserOverlayVisible,
  setBrowserViewport,
  shouldBlockSystemBrowserOpen,
  showBrowserCursorAction,
  systemBrowserOpenBlockMessage,
  typeBrowserRef,
  waitBrowser,
  withBrowserOwner,
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

function createBrowserTools(durable, { temporary = false } = {}) {
  const { defineExtension } = durable;
  function defineTool(spec) {
    return durable.defineTool({ ...spec, execute(args, api, context) {
      const owner = require('../../services/tool-window.cjs').browserConversationOwner(api.conversationId, temporary);
      return withBrowserOwner(owner, () => spec.execute(args, api, context));
    } });
  }
  const Type = toolSchema;

  const browserTabs = defineTool({
    name: 'browser_tabs',
    description: 'List, focus, or close tabs in the Studio workbench browser.',
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: 'list (default), focus, or close' })),
      tabId: Type.Optional(Type.String({ description: 'Tab id when action is focus or close' })),
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
      if (action === 'close') {
        if (!args.tabId) throw new Error('关闭标签需要 tabId');
        const tab = requestCloseBrowserTab(args.tabId);
        return textResult(`已关闭：${tab.title || tab.url || tab.id}`, { tab, tabs: listBrowserTabs() });
      }
      if (action !== 'list') throw new Error(`不支持的 action：${args.action}`);
      const tabs = listBrowserTabs();
      return textResult(formatTabs(tabs), { tabs });
    },
  });

  const browserOpen = defineTool({
    name: 'browser_open',
    description: 'PRIMARY browser tool: open a page in the Studio tool window browser where the user watches and interacts live. Always prefer Studio workbench browser_* tools over external Chrome DevTools MCP for opening pages, UI testing, clicking, forms, screenshots, console/network checks, and responsive viewport inspection.',
    parameters: Type.Object({
      url: Type.String({ description: 'http(s) URL, about:blank, file:// HTML URL, or absolute/relative path to a .html file' }),
      newTab: Type.Optional(Type.Boolean({ description: 'Force a new tab even if URL is already open' })),
    }),
    async execute(args, api, context) {
      ensureAgentBrowser();
      let cwd = '';
      try {
        cwd = (await api.agent(context)).cwd || '';
      } catch {
        cwd = '';
      }
      const url = resolveBrowserOpenUrl(args.url, cwd);
      assertSiteActionAllowed(url, 'navigate');
      const token = beginBrowserActivity({ action: 'open', label: `打开 ${url.slice(0, 48)}` });
      try {
        const tab = await requestOpenBrowserTab(url, { newTab: args.newTab === true });
        if (tab?.id) {
          void showBrowserCursorAction(tab.id, { label: `已打开 ${url.slice(0, 48)}`, kind: 'move' });
        }
        return textResult(`已打开：${tab.url || url}`, { tab, tabs: listBrowserTabs() });
      } finally {
        endBrowserActivity(token);
      }
    },
  });

  const browserNavigate = defineTool({
    name: 'browser_navigate',
    description: 'Navigate the active (or specified) workbench browser tab: load a URL, go back/forward, or reload.',
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
      const label = url ? `导航到 ${url.slice(0, 48)}` : ({ back: '后退', forward: '前进', reload: '刷新页面' }[action] || '页面导航');
      const token = beginBrowserActivity({ tabId: tabId || '', action: 'navigate', label });
      try {
        let tab;
        if (url) {
          assertSiteActionAllowed(url, 'navigate');
          requestRevealBrowserTab(tabId || '');
          tab = await navigateBrowserTab(tabId, url);
        } else if (action) {
          const current = resolveBrowserTab(tabId);
          assertSiteActionAllowed(current.url, 'navigate');
          requestRevealBrowserTab(current.id);
          tab = await controlBrowserTab(tabId, action);
        } else {
          throw new Error('请提供 url，或 action（back/forward/reload）');
        }
        if (tab?.id) void showBrowserCursorAction(tab.id, { label, kind: 'move' });
        return textResult(`${tab.title || ''} ${tab.url || ''}`.trim(), { tab });
      } finally {
        endBrowserActivity(token);
      }
    },
  });

  const browserSnapshot = defineTool({
    name: 'browser_snapshot',
    description: 'PRIMARY page reading & targeting tool. Captures a compact structural outline of the page with element ref ids (e.g. [e12]) for browser_click/browser_type/browser_scroll. Use viewportOnly=true after scrolling long pages to inspect on-screen elements, selector to scope to a region (e.g. main/table/form), or mode="text" to extract clean readable prose and Markdown tables. Prefer browser_snapshot over browser_screenshot for reading text, tables, and locating interactive controls.',
    parameters: Type.Object({
      tabId: Type.Optional(Type.String({ description: 'Target tab id; defaults to the active tab' })),
      mode: Type.Optional(Type.String({ description: 'dom_lite (default) | a11y | text (clean main text & Markdown tables)' })),
      viewportOnly: Type.Optional(Type.Boolean({ description: 'Only include elements currently visible in the viewport (recommended after scrolling long pages)' })),
      selector: Type.Optional(Type.String({ description: 'Optional CSS selector to scope the snapshot (e.g. main, article, table, form)' })),
      maxChars: Type.Optional(Type.Number({ minimum: 2000, maximum: 40000, description: 'Soft size budget for the snapshot output' })),
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
        viewportOnly: args.viewportOnly === true,
        selector: args.selector,
        includeIframes: args.includeIframes,
      });
      const details = {
        tabId: entry.id,
        url: snapshot.url,
        title: snapshot.title,
        mode: snapshot.mode,
        viewportOnly: Boolean(snapshot.viewportOnly),
        scroll: snapshot.scroll,
        truncated: snapshot.truncated,
        omittedCount: snapshot.omittedCount,
        stampedCount: snapshot.stampedCount,
        nodeCount: Object.keys(snapshot.refs || {}).length,
        refs: snapshot.refs,
        tree: snapshot.tree,
        warnings: snapshot.warnings,
      };
      const scrollLine = snapshot.scroll
        ? `viewport: ${snapshot.scroll.viewportWidth}×${snapshot.scroll.viewportHeight}, scroll: ${snapshot.scroll.y}/${Math.max(0, snapshot.scroll.height - snapshot.scroll.viewportHeight)}px (total height ${snapshot.scroll.height}px)`
        : '';
      const body = snapshot.mode === 'text'
        ? (snapshot.text || '（页面无可读文本）')
        : (snapshot.outline || JSON.stringify({ refs: snapshot.refs, tree: snapshot.tree }));
      const summary = [
        `url: ${snapshot.url || entry.url || ''}`,
        `title: ${snapshot.title || entry.title || ''}`,
        `mode: ${snapshot.mode || 'dom_lite'}${snapshot.viewportOnly ? ' (viewportOnly)' : ''}`,
        scrollLine,
        snapshot.mode !== 'text' ? `nodes: ${details.nodeCount}${snapshot.truncated ? ' (truncated)' : ''}` : '',
        snapshot.warnings?.length ? `warnings: ${snapshot.warnings.join('; ')}` : '',
        body,
      ].filter(Boolean).join('\n');
      return textResult(summary, details);
    },
  });

  const browserScreenshot = defineTool({
    name: 'browser_screenshot',
    description: 'Capture a JPEG screenshot of the current workbench browser viewport or a specific element by ref. Use for visual layout verification, charts/canvas, or when the user asks for a screenshot — prefer browser_snapshot for routine reading and element targeting.',
    parameters: Type.Object({
      tabId: Type.Optional(Type.String({ description: 'Target tab id; defaults to the active tab' })),
      ref: Type.Optional(Type.String({ description: 'Optional element ref from browser_snapshot to crop the screenshot to that element' })),
      clean: Type.Optional(Type.Boolean({ description: 'Temporarily hide the live AI cursor overlay during capture (default true)' })),
    }),
    replay: 'safe',
    async execute(args) {
      ensureAgentBrowser();
      const entry = resolveBrowserTab(args.tabId);
      assertSiteActionAllowed(entry.url, 'read');
      const contents = getTabWebContents(entry);
      if (!contents) throw new Error('浏览器标签尚未就绪，请先 browser_open 或等待页面加载');
      const hideOverlay = args.clean !== false;
      let rect;
      if (args.ref) {
        rect = await getElementRect(entry.id, args.ref);
        if (!rect) throw new Error(`找不到截图目标元素 ${args.ref}，请重新 browser_snapshot`);
      }
      if (hideOverlay) await setBrowserOverlayVisible(entry.id, false);
      let shot;
      try {
        shot = await captureBrowserScreenshot(contents, { rect });
      } finally {
        if (hideOverlay) await setBrowserOverlayVisible(entry.id, true);
      }
      const label = `${entry.title || entry.url || entry.id}${args.ref ? ` [${args.ref}]` : ''} (${shot.width}×${shot.height})`;
      return {
        output: [
          { type: 'text', text: `截图：${label}` },
          { type: 'image', mimeType: shot.mimeType, data: shot.data },
        ],
        details: {
          tabId: entry.id,
          url: entry.url,
          title: entry.title,
          ref: args.ref || undefined,
          width: shot.width,
          height: shot.height,
        },
      };
    },
  });

  const browserClick = defineTool({
    name: 'browser_click',
    description: 'Click an element from the latest browser_snapshot by ref (supports left/right/middle click and doubleClick, with live visible cursor feedback).',
    parameters: Type.Object({
      ref: Type.String({ description: 'Element ref from browser_snapshot (e.g. e12)' }),
      tabId: Type.Optional(Type.String()),
      button: Type.Optional(Type.String({ description: 'left (default) | right | middle' })),
      doubleClick: Type.Optional(Type.Boolean({ description: 'Double-click the target element' })),
      snapshot: Type.Optional(Type.Boolean({ description: 'Include a compact follow-up snapshot summary (default true)' })),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const result = await clickBrowserRef(args.tabId, args.ref, {
        button: args.button,
        doubleClick: args.doubleClick,
        snapshot: args.snapshot,
      });
      return textResult(`已点击 ${args.ref}（${result.element?.name || result.element?.tag || ''}）`, result);
    },
  });

  const browserHover = defineTool({
    name: 'browser_hover',
    description: 'Hover the live pointer over an element from browser_snapshot by ref to reveal tooltips, hover menus, or CSS :hover states.',
    parameters: Type.Object({
      ref: Type.String({ description: 'Element ref from browser_snapshot (e.g. e12)' }),
      tabId: Type.Optional(Type.String()),
      snapshot: Type.Optional(Type.Boolean({ description: 'Include a compact follow-up snapshot summary (default true)' })),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const result = await hoverBrowserRef(args.tabId, args.ref, { snapshot: args.snapshot });
      return textResult(`已悬停 ${args.ref}（${result.element?.name || result.element?.tag || ''}）`, result);
    },
  });

  const browserType = defineTool({
    name: 'browser_type',
    description: 'Type a full text string in one call with live cursor feedback into an element by ref, or into the currently focused input when ref is omitted (e.g. after pressing "/" to open search). Always use browser_type for entering words or queries instead of calling browser_press letter-by-letter.',
    parameters: Type.Object({
      ref: Type.Optional(Type.String({ description: 'Optional element ref from browser_snapshot; omit to type into the currently focused input' })),
      text: Type.String({ description: 'Full text to type in one call' }),
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
      return textResult(args.ref ? `已输入到 ${args.ref}` : '已输入到当前聚焦输入框', result);
    },
  });

  const browserPress = defineTool({
    name: 'browser_press',
    description: 'Send a single keyboard special key or shortcut to the workbench browser (e.g. Escape, Tab, Shift+Tab, Enter, ArrowDown, /, Meta+K, Control+A). Never call browser_press repeatedly letter-by-letter to type words — use browser_type instead.',
    parameters: Type.Object({
      key: Type.String({ description: 'Key or chord such as Escape, Tab, Shift+Tab, Enter, Space, ArrowDown, Meta+K' }),
      ref: Type.Optional(Type.String({ description: 'Optional element ref to focus before pressing the key' })),
      tabId: Type.Optional(Type.String()),
      snapshot: Type.Optional(Type.Boolean({ description: 'Include a compact follow-up snapshot summary (default false)' })),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const result = await pressBrowserKey(args.tabId, args.key, {
        ref: args.ref,
        snapshot: args.snapshot,
      });
      return textResult(`已按下 ${result.key}`, result);
    },
  });

  const browserDrag = defineTool({
    name: 'browser_drag',
    description: 'Drag an element from sourceRef to targetRef in the workbench browser with live cursor feedback.',
    parameters: Type.Object({
      sourceRef: Type.String({ description: 'Source element ref from browser_snapshot' }),
      targetRef: Type.String({ description: 'Target element ref from browser_snapshot' }),
      tabId: Type.Optional(Type.String()),
      snapshot: Type.Optional(Type.Boolean()),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const result = await dragBrowserRefs(args.tabId, args.sourceRef, args.targetRef, { snapshot: args.snapshot });
      return textResult(`已拖拽 ${args.sourceRef} → ${args.targetRef}`, result);
    },
  });

  const browserViewport = defineTool({
    name: 'browser_viewport',
    description: 'Emulate a specific viewport size or responsive preset in the workbench browser (desktop 1440×900, laptop 1280×800, tablet 768×1024, mobile 390×844, or reset). Because the right-side workbench panel is narrower than a desktop screen, call browser_viewport(preset="laptop" or "desktop") before performing desktop UI testing, layout inspection, or visual screenshots; reset afterwards if appropriate.',
    parameters: Type.Object({
      preset: Type.Optional(Type.String({ description: 'desktop | laptop | tablet | mobile | reset' })),
      width: Type.Optional(Type.Number({ minimum: 320, maximum: 2560, description: 'Viewport width in CSS pixels' })),
      height: Type.Optional(Type.Number({ minimum: 320, maximum: 1800, description: 'Viewport height in CSS pixels' })),
      reset: Type.Optional(Type.Boolean({ description: 'Reset to responsive panel width when true' })),
      tabId: Type.Optional(Type.String()),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const result = await setBrowserViewport(args.tabId, args);
      const summary = result.viewport
        ? `已设置视口：${result.viewport.width}×${result.viewport.height}（实际 ${result.actual?.innerWidth || '?'}×${result.actual?.innerHeight || '?'}）`
        : `已恢复自适应视口（实际 ${result.actual?.innerWidth || '?'}×${result.actual?.innerHeight || '?'}）`;
      return textResult(summary, result);
    },
  });

  const browserConsole = defineTool({
    name: 'browser_console',
    description: 'Read the current page’s console logs, warnings, uncaught errors, and load failures, even when its DevTools window is closed. Use level="error" to check a test for runtime failures.',
    parameters: Type.Object({
      tabId: Type.Optional(Type.String({ description: 'Target tab id; defaults to the active tab' })),
      level: Type.Optional(Type.String({ description: 'Filter by level: error | warning | info | verbose' })),
      search: Type.Optional(Type.String({ description: 'Case-insensitive substring filter' })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: 'Max entries to return (default 60)' })),
      clear: Type.Optional(Type.Boolean({ description: 'Clear console buffer after reading' })),
    }),
    replay: 'safe',
    async execute(args) {
      ensureAgentBrowser();
      const result = listBrowserConsole(args.tabId, args);
      const lines = result.entries.map((item) => {
        const loc = item.source ? ` (${item.source}${item.line ? `:${item.line}` : ''})` : '';
        return `[${item.level}] ${item.message}${loc}`;
      });
      const header = `console: total=${result.summary.total}, errors=${result.summary.errors}, warnings=${result.summary.warnings}`;
      return textResult(lines.length ? `${header}\n${lines.join('\n')}` : `${header}\n（无匹配日志）`, result);
    },
  });

  const browserNetwork = defineTool({
    name: 'browser_network',
    description: 'Read captured HTTP network requests, status codes, durations, and failures for the workbench browser tab (works without enabling CDP).',
    parameters: Type.Object({
      tabId: Type.Optional(Type.String({ description: 'Target tab id; defaults to the active tab' })),
      failedOnly: Type.Optional(Type.Boolean({ description: 'Only return 4xx/5xx or network errors' })),
      statusMin: Type.Optional(Type.Number({ minimum: 100, maximum: 599, description: 'Minimum HTTP status code (e.g. 400)' })),
      resourceType: Type.Optional(Type.String({ description: 'Filter by resource type such as xhr, fetch, mainFrame, script, stylesheet, image' })),
      urlIncludes: Type.Optional(Type.String({ description: 'Case-insensitive URL substring filter' })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: 'Max entries to return (default 60)' })),
      clear: Type.Optional(Type.Boolean({ description: 'Clear network buffer after reading' })),
    }),
    replay: 'safe',
    async execute(args) {
      ensureAgentBrowser();
      const entry = resolveBrowserTab(args.tabId);
      assertSiteActionAllowed(entry.url, 'read');
      const result = listBrowserNetwork(entry.id, args);
      const lines = result.entries.map((item) => {
        const status = item.error ? `ERR(${item.error})` : String(item.statusCode || '—');
        return `${item.method} ${status} [${item.resourceType}] ${item.durationMs}ms ${item.url}`;
      });
      const header = `network: total=${result.summary.total}, failed=${result.summary.failed}`;
      return textResult(lines.length ? `${header}\n${lines.join('\n')}` : `${header}\n（无匹配请求）`, result);
    },
  });

  const browserScroll = defineTool({
    name: 'browser_scroll',
    description: 'Scroll the page by direction/amount, jump directly to top/bottom (position), or scroll a specific ref or CSS selector (e.g. #browser_compatibility) into view.',
    parameters: Type.Object({
      tabId: Type.Optional(Type.String()),
      ref: Type.Optional(Type.String({ description: 'If set, scroll this ref into view' })),
      selector: Type.Optional(Type.String({ description: 'Optional CSS selector (e.g. #browser_compatibility, h2) to scroll directly into view' })),
      position: Type.Optional(Type.String({ description: 'top | bottom to jump directly to the top or bottom of the page' })),
      direction: Type.Optional(Type.String({ description: 'down | up | left | right' })),
      amount: Type.Optional(Type.Number({ minimum: 1, maximum: 4000 })),
    }),
    async execute(args) {
      ensureAgentBrowser();
      const result = await scrollBrowser(args.tabId, args);
      const maxScroll = Math.max(0, (result.scrollHeight || 0) - (result.viewportHeight || 0));
      const pos = Number.isFinite(result.y) && result.scrollHeight
        ? `（scrollY=${result.y}/${maxScroll}px）`
        : '';
      const label = result.mode === 'ref'
        ? `已滚到 ${args.ref}`
        : result.mode === 'selector'
          ? `已滚到 ${args.selector}`
          : result.mode === 'top'
            ? '已滚回顶部'
            : result.mode === 'bottom'
              ? '已滚到底部'
              : `已滚动 ${args.direction || 'down'}`;
      return textResult(`${label}${pos}`, result);
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
      browserHover,
      browserType,
      browserPress,
      browserDrag,
      browserScroll,
      browserWait,
      browserSelect,
      browserViewport,
      browserConsole,
      browserNetwork,
      browserDialog,
      browserDownload,
      browserHighlight,
      browserEvaluate,
      browserCdp,
      browserExternal,
    ],
    sections: [
      // Controlled by Settings → 浏览器 →「向 Agent 说明打开规则」.
      durable.section('studio-browser-open', () => {
        const preferences = getBrowserPreferences();
        if (preferences.linkOpenInstructAgent === false) return '';
        return browserPreferenceInstructions(preferences);
      }),
    ],
    hooks: [
      durable.hook(durable.ToolTask, {
        async beforeTool(call, api) {
          const name = String(call?.name || '');
          if (name.startsWith('browser_')) {
            beginBrowserSession(api?.conversationId || 'default');
            return;
          }
          if (name !== 'bash') return;
          const command = String(call.arguments?.command || '');
          // Controlled by Settings → 浏览器 →「拦截外部打开」(+ open targets).
          if (!shouldBlockSystemBrowserOpen(command)) return;
          return {
            block: systemBrowserOpenBlockMessage(command),
          };
        },
      }),
      durable.hook(durable.GenerationTask, {
        async afterRun(_run, api) {
          endBrowserSession(api?.conversationId || 'default');
          return undefined;
        },
      }),
    ],
  });
}

module.exports = {
  createBrowserTools,
};
