/**
 * Desktop observation + constrained click/type/scroll/drag/hotkey tools (Codex Computer Use–style).
 */
const { createDesktopFailureHandling } = require('./tool-failures.cjs');
const { getStudioDatabase } = require('../../core/studio-db.cjs');
const toolSchema = require('../../runtime/tool-schema.cjs');
const {
  withDesktopControlRun,
  getDesktopControlStatus,
  listDesktopApps,
  listDesktopWindows,
  launchAllowedDesktopApp,
  actAllowedDesktop,
  captureAllowedDesktopSnapshot,
  captureAllowedDesktopScreenshot,
  clickAllowedDesktop,
  typeAllowedDesktop,
  scrollAllowedDesktop,
  dragAllowedDesktop,
  hotkeyAllowedDesktop,
} = require('../../services/desktop-control/index.cjs');

function sessionIdFromApi(api) {
  if (!api || api.conversationId == null) return '';
  const raw = String(api.conversationId);
  try {
    const row = getStudioDatabase().getConversation(raw);
    if (row && row.publicId) return String(row.publicId);
  } catch {
    /* unit tests without initialized Studio DB fall back to raw conversationId */
  }
  return raw;
}

function screenshotBlocks(shot, header = '') {
  const blocks = [];
  for (const image of [shot, ...(shot.panels || [])]) {
    if (!image.data) continue;
    const main = image === shot;
    const parts = main ? [header, `主窗口 #${shot.windowId}`].filter(Boolean)
      : [`同应用弹窗 #${image.windowId}，点击这张图时使用 desktop_click 或单步 desktop_act，主窗口 windowId=${shot.windowId}，动作 popupWindowId=${image.windowId}`];
    if (image.bounds) parts.push(`窗口 ${image.bounds.width}×${image.bounds.height} @(${image.bounds.x},${image.bounds.y})`);
    if (image.imageWidth && image.imageHeight) parts.push(`图片 ${image.imageWidth}×${image.imageHeight}`);
    if (main && shot.popupRegions?.length) {
      const ids = shot.popupRegions.map(region => `#${region.windowId}`).join('、');
      parts.push(`主图内的弹窗 ${ids}，直接按主图坐标单独点击，工具会绑定相应弹窗`);
    }
    if (main && shot.captureMode && !shot.popupRegions?.length && shot.overlayCount === 0) parts.push('仅取得主窗口画面，独立弹窗 0 个；搜索结果可能显示在主图中');
    if (main && shot.accessibilityOptions?.length) parts.push(`输入控件中可见的候选项：${JSON.stringify(shot.accessibilityOptions)}`);
    parts.push('normX/normY 以这张图为基准 (0–1000)');
    blocks.push({ type: 'text', text: parts.join(' · ') }, { type: 'image', mimeType: image.mimeType, data: image.data });
  }
  return blocks;
}

function screenshotMetadata(image) {
  return {
    windowId: image.windowId,
    bounds: image.bounds || null,
    imageWidth: image.imageWidth || null,
    imageHeight: image.imageHeight || null,
    bytes: image.bytes,
    ...(image.captureMode ? { captureMode: image.captureMode, overlayCount: image.overlayCount ?? 0 } : {}),
    mimeType: image.mimeType,
    ...(image.panels?.length ? { panels: image.panels.map(screenshotMetadata) } : {}),
    ...(image.popupRegions?.length ? { popupRegions: image.popupRegions } : {}),
    ...(image.accessibilityOptions?.length ? { accessibilityOptions: image.accessibilityOptions } : {}),
  };
}

function textResult(text, details) {
  const payload = { output: [{ type: 'text', text: String(text || '') }] };
  if (details !== undefined) payload.details = details;
  return payload;
}

function formatTypeOutcome(result) {
  const value = result.valueVerified === true ? '已核对输入框原文' : '输入框原文待核对';
  return `已执行文本输入（${result.chars || 0} 字符），${value}${result.submitted ? '，已按一次回车，请核对应用中的提交结果' : ''}`;
}

function formatStatus(status) {
  const permission = status.permission || {};
  const lines = [
    `enabled: ${status.enabled ? 'yes' : 'no'}`,
    `allowAnyApp: ${status.allowAnyApp ? 'yes' : 'no'}`,
    `alwaysAllow: ${status.alwaysAllowCount || 0}`,
    `platform: ${status.platform || 'unknown'}`,
    `supported: ${status.supported ? 'yes' : 'no'}`,
    `screenRecording: ${permission.screenRecording || 'unknown'}`,
    `accessibility: ${permission.accessibility ? 'granted' : 'missing'}`,
    ...(permission.keyboardInput ? [`keyboardInput: ${permission.keyboardInput}`] : []),
    `ready: ${status.ready ? 'yes' : 'no'}`,
  ];
  const actions = Array.isArray(status.actions) && status.actions.length
    ? status.actions.join(', ')
    : 'observe, click, type, scroll, drag, hotkey';
  lines.push(`actions: ${actions}`);
  if (permission.message) lines.push(`note: ${permission.message}`);

  const missing = [];
  if (!status.enabled) missing.push('enable master switch');
  if (!permission.accessibility) missing.push('grant Accessibility');
  if (permission.screenRecording !== 'granted') missing.push('grant Screen Recording');
  if (permission.keyboardInput === 'denied') missing.push('check helper Accessibility and refresh keyboard permissions');
  if (!status.allowAnyApp && !(status.alwaysAllowCount > 0)) {
    lines.push('app approval: desktop_launch can request access to the target for this conversation');
  }
  if (missing.length) lines.push(`todo: ${missing.join('; ')}`);
  else lines.push('todo: none');

  const activity = Array.isArray(status.activity) ? status.activity.slice(0, 8) : [];
  if (activity.length) {
    lines.push('recent:');
    for (const row of activity) {
      const when = row.at ? new Date(row.at).toISOString() : '';
      const mark = row.ok === false ? 'fail' : 'ok';
      const parts = [
        mark,
        row.tool || 'tool',
        row.appName || '',
        row.windowId != null ? `#${row.windowId}` : '',
        row.code || '',
        row.detail || '',
        when,
      ].filter(Boolean);
      lines.push(`- ${parts.join(' · ')}`);
    }
  } else {
    lines.push('recent: (none)');
  }

  return lines.join('\n');
}

function createDesktopControlTools(durable, observeDesktopRun) {
  const { defineExtension, defineTool } = durable;
  const Type = toolSchema;
  const chatTarget = Type.Optional(Type.Object({
    requested: Type.String({ description: 'Exact recipient named by the user' }),
    visibleTitle: Type.String({ description: 'Full selected conversation header read from the latest image or AX label' }),
    composer: Type.Optional(Type.String({ enum: ['empty', 'prepared', 'existing', 'unreadable'], description: 'Required before editing or sending. Inspect the entire composer and attachment area in the latest main-window image. empty = no text, image, file or staged item; prepared = only content this run just entered; existing = any other draft or attachment; unreadable = uncertain.' })),
  }, { description: 'For a message, include this before composing, submitting or clicking Send. For the current chat, quote the user’s explicit current-chat reference and the originally selected title.' }));
  const searchField = Type.Optional(Type.Boolean({ description: 'For search or autocomplete, set true and leave submit off to observe suggestions in this call. Use the current field or focus it in the same batch.' }));

  const desktopStatus = defineTool({
    name: 'desktop_status',
    description: 'Show whether desktop control is enabled, OS permissions (macOS & Windows), supported actions/tools, what is still missing, and a short recent activity log (metadata only: tool/app/window/time; never screenshots, UI text, or typed content). Read-only.',
    parameters: Type.Object({}),
    replay: 'safe',
    async execute() {
      const raw = await getDesktopControlStatus();
      // Keep tool details lean: drop app icons from alwaysAllow for the model payload.
      const status = {
        ...raw,
        alwaysAllow: Array.isArray(raw.alwaysAllow)
          ? raw.alwaysAllow.map((app) => ({
            id: app.id,
            name: app.name,
            bundleId: app.bundleId || '',
            path: app.path || '',
          }))
          : [],
        activity: Array.isArray(raw.activity)
          ? raw.activity.slice(0, 20).map((row) => ({
            id: row.id,
            at: row.at,
            tool: row.tool,
            ok: row.ok !== false,
            code: row.code || '',
            appName: row.appName || '',
            bundleId: row.bundleId || '',
            windowId: row.windowId == null ? null : row.windowId,
            title: row.title || '',
            detail: row.detail || '',
          }))
          : [],
      };
      return textResult(formatStatus(status), status);
    },
  });

  const desktopApps = defineTool({
    name: 'desktop_apps',
    description: 'List running desktop applications (macOS & Windows) and whether each one is already allowed for desktop observation. Does not return window contents. Requires desktop control enabled; does not require Accessibility (so the agent can suggest apps to allow before full observation is ready).',
    parameters: Type.Object({}),
    replay: 'safe',
    async execute() {
      const apps = await listDesktopApps();
      if (!apps.length) return textResult('当前没有前台运行中的应用。', { apps });
      const lines = apps.map((app) => {
        const mark = app.allowed ? 'allow' : (app.blocked ? 'block' : 'need');
        return `${mark}\t${app.name}\t${app.bundleId || ''}`;
      });
      return textResult(lines.join('\n'), { apps });
    },
  });

  const desktopWindows = defineTool({
    name: 'desktop_windows',
    description: 'List windows for allowed apps only. Other apps appear in skipped with needsApproval. Use windowId with desktop_snapshot / desktop_screenshot. Never captures screen content.',
    parameters: Type.Object({
      appName: Type.Optional(Type.String({ description: 'Optional running application name filter' })),
      bundleId: Type.Optional(Type.String({ description: 'Optional bundle id filter' })),
    }),
    replay: 'safe',
    async execute(args, api) {
      const result = await listDesktopWindows({
        appName: args.appName,
        bundleId: args.bundleId,
        sessionId: sessionIdFromApi(api),
      });
      const windowLines = (result.windows || []).map((win) => {
        const b = win.bounds && win.bounds.width > 0
          ? `bounds=${win.bounds.x},${win.bounds.y},${win.bounds.width}x${win.bounds.height}`
          : '';
        return `${win.windowId}\t${win.appName}\t${win.minimized ? 'minimized' : (win.visible === false ? 'offscreen' : 'visible')}${win.main ? ' · main' : ''}\t${win.title || '(no title)'}${b ? `\t${b}` : ''}`;
      });
      const skippedLines = (result.skipped || []).map((row) => (
        `${row.decision}\t${row.name}\t${row.reason || ''}`
      ));
      const parts = [];
      parts.push(windowLines.length ? `windows:\n${windowLines.join('\n')}` : 'windows: (none)');
      if (skippedLines.length) parts.push(`skipped:\n${skippedLines.join('\n')}`);
      return textResult(parts.join('\n\n'), result);
    },
  });

  const desktopLaunch = defineTool({
    name: 'desktop_launch',
    description: 'Reuse a known application window or launch the app, request app approval when needed, and return its windowId and initial image. On macOS the agent requests a background launch.',
    parameters: Type.Object({
      appName: Type.Optional(Type.String({ description: 'Application display name or English name' })),
      bundleId: Type.Optional(Type.String({ description: 'Optional macOS bundle ID or Windows exe/AUMID (e.g. com.apple.calculator, notepad.exe)' })),
      path: Type.Optional(Type.String({ description: 'Optional application path (.app on macOS or .exe on Windows)' })),
      waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: 15000, description: 'Max milliseconds to wait for a visible window (default 5000)' })),
      screenshot: Type.Optional(Type.Boolean({ description: 'Return the initial window image and any separately captured same-app panels (default true)' })),
    }),
    replay: 'unsafe',
    async execute(args, api) {
      // Older sessions can replay a call made against the former tool schema.
      if (args.bringToFront === true) {
        throw Object.assign(new Error('请使用预览窗口中的手动按钮将目标应用切到前台。'), { code: 'desktop_agent_focus_blocked' });
      }
      const result = await launchAllowedDesktopApp({
        appName: args.appName,
        bundleId: args.bundleId,
        path: args.path,
        waitMs: args.waitMs,
        bringToFront: false,
        screenshot: args.screenshot !== false,
        sessionId: sessionIdFromApi(api),
      });
      const statusText = result.alreadyRunning ? '已在运行' : '已启动';
      const winText = result.windowId != null ? `windowId=${result.windowId}` : '暂未检测到可见窗口';
      const boundsText = result.bounds && result.bounds.width > 0
        ? ` · 窗口 ${result.bounds.width}×${result.bounds.height} @(${result.bounds.x},${result.bounds.y})`
        : '';
      const header = `${statusText}：${result.displayName || result.appName}（${result.bundleId || result.path || ''}）· ${winText}${boundsText}`;
      if (result.screenshot && result.screenshot.data) {
        const shot = result.screenshot;
        return {
          output: screenshotBlocks(shot, header),
          details: { ...result, screenshot: screenshotMetadata(shot) },
        };
      }
      const observation = result.screenshotError ? `\n截图失败：${result.screenshotError.message}` : '';
      return textResult(header + observation, result);
    },
  });

  const desktopAct = defineTool({
    name: 'desktop_act',
    description: 'Batch consecutive desktop actions up to the next decision that needs observation. Returns completed steps, the main image and any independently captured same-app popup images by default. Type supplies literal text including Latin letters and Chinese. submit:true presses Enter once.',
    parameters: Type.Object({
      appName: Type.Optional(Type.String({ description: 'Target application display or English name' })),
      bundleId: Type.Optional(Type.String({ description: 'Optional bundle ID or Windows exe/AUMID' })),
      path: Type.Optional(Type.String({ description: 'Optional application path' })),
      windowId: Type.Optional(Type.Number({ description: 'Optional windowId (auto-resolved or auto-launched if omitted)' })),
      chatTarget,
      searchField,
      actions: Type.Array(Type.Object({
        type: Type.String({ description: 'Action kind: launch | click | double_click | right_click | type | hotkey | scroll | drag | wait' }),
        popupWindowId: Type.Optional(Type.Number({ description: 'For click, double_click or right_click on a separately returned popup image, use its windowId here and its own normX/normY. Keep the main windowId on the batch.' })),
        ref: Type.Optional(Type.String({ description: 'Optional accessibility ref from desktop_snapshot' })),
        elementPath: Type.Optional(Type.String({ description: 'Optional accessibility path' })),
        normX: Type.Optional(Type.Number({ minimum: 0, maximum: 1000, description: 'Window-normalized X (0=left edge, 1000=right edge). Preferred for visual clicks!' })),
        normY: Type.Optional(Type.Number({ minimum: 0, maximum: 1000, description: 'Window-normalized Y (0=top edge, 1000=bottom edge). Preferred for visual clicks!' })),
        rx: Type.Optional(Type.Number({ description: 'Window-relative X offset from window top-left (or image X when imageWidth is provided)' })),
        ry: Type.Optional(Type.Number({ description: 'Window-relative Y offset from window top-left (or image Y when imageHeight is provided)' })),
        imageWidth: Type.Optional(Type.Number({ description: 'Optional screenshot pixel width when passing screenshot pixel coords in rx/ry' })),
        imageHeight: Type.Optional(Type.Number({ description: 'Optional screenshot pixel height when passing screenshot pixel coords in rx/ry' })),
        x: Type.Optional(Type.Number({ description: 'Optional absolute screen X' })),
        y: Type.Optional(Type.Number({ description: 'Optional absolute screen Y' })),
        button: Type.Optional(Type.String({ description: 'left | right' })),
        double: Type.Optional(Type.Boolean({ description: 'Double click when true' })),
        text: Type.Optional(Type.String({ description: 'Text to type (native Unicode/Chinese supported!)' })),
        clear: Type.Optional(Type.Boolean({ description: 'Select all and clear field before typing' })),
        submit: Type.Optional(Type.Boolean({ description: 'Press Enter right after typing' })),
        key: Type.Optional(Type.String({ description: 'Hotkey key or chord (e.g. "cmd+f", "ctrl+f", "enter", "escape")' })),
        modifiers: Type.Optional(Type.Array(Type.String(), { description: 'Optional modifier keys' })),
        direction: Type.Optional(Type.String({ description: 'Scroll direction: up | down | left | right' })),
        amount: Type.Optional(Type.Number({ description: 'Scroll amount (default 3, max 40)' })),
        toNormX: Type.Optional(Type.Number({ minimum: 0, maximum: 1000, description: 'Drag end normalized X (0..1000)' })),
        toNormY: Type.Optional(Type.Number({ minimum: 0, maximum: 1000, description: 'Drag end normalized Y (0..1000)' })),
        toRx: Type.Optional(Type.Number({ description: 'Drag end window-relative X' })),
        toRy: Type.Optional(Type.Number({ description: 'Drag end window-relative Y' })),
        toX: Type.Optional(Type.Number({ description: 'Drag end screen X' })),
        toY: Type.Optional(Type.Number({ description: 'Drag end screen Y' })),
        ms: Type.Optional(Type.Number({ minimum: 30, maximum: 5000, description: 'Wait duration in milliseconds' })),
        waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: 15000, description: 'Launch wait timeout in milliseconds' })),
      }), { description: 'Ordered list of up to 16 micro-actions to run sequentially (e.g. click input -> type text with submit:true)' }),
      screenshot: Type.Optional(Type.Boolean({ description: 'Capture updated window and available same-app popup images (default true)' })),
      settleMs: Type.Optional(Type.Number({ minimum: 0, maximum: 3000, description: 'Fixed delay before capture. Omit for automatic popup waiting during search, or 260 ms for other actions.' })),
      autoLaunch: Type.Optional(Type.Boolean({ description: 'Launch the app automatically if not running (default true)' })),
    }),
    replay: 'unsafe',
    async execute(args, api) {
      const result = await actAllowedDesktop({
        appName: args.appName,
        bundleId: args.bundleId,
        path: args.path,
        windowId: args.windowId,
        actions: args.actions || [],
        searchField: args.searchField === true,
        screenshot: args.screenshot !== false,
        settleMs: args.settleMs,
        autoLaunch: args.autoLaunch !== false,
        sessionId: sessionIdFromApi(api),
      });
      const stepLines = (result.steps || []).map((step) => {
        const outcome = step.ok ? (step.type === 'type' ? formatTypeOutcome(step) : 'ok')
          : `fail (${step.code || ''} ${step.error || ''})`;
        return `${step.index}. ${step.type}: ${outcome}`;
      });
      const lines = [
        `app: ${result.appName || ''} #${result.windowId ?? ''}`,
        result.ok ? `completed ${stepLines.length} step(s)` : `stopped at step ${result.failedStep?.index}: ${result.failedStep?.error}`,
        ...stepLines,
      ];
      if (result.screenshotError) lines.push(`截图失败：${result.screenshotError.message}`);
      if (result.screenshot && result.screenshot.data) {
        const shot = result.screenshot;
        return {
          output: screenshotBlocks(shot, lines.join('\n')),
          details: {
            ok: result.ok,
            ...(typeof result.staged === 'boolean' ? { staged: result.staged } : {}),
            appName: result.appName,
            bundleId: result.bundleId,
            windowId: result.windowId,
            bounds: result.bounds,
            steps: result.steps,
            failedStep: result.failedStep || null,
            screenshot: screenshotMetadata(shot),
          },
        };
      }
      return textResult(lines.join('\n'), result);
    },
  });

  const desktopSnapshot = defineTool({
    name: 'desktop_snapshot',
    description: 'Capture a bounded accessibility tree for one allowed application window. Prefer specifying windowId from desktop_windows; when set, the id must belong to that app. Secure/password fields omit values. Nodes may include bounds, path, and ref for desktop_click / desktop_type targeting.',
    parameters: Type.Object({
      appName: Type.Optional(Type.String({ description: 'Running application name' })),
      bundleId: Type.Optional(Type.String({ description: 'Application bundle id' })),
      path: Type.Optional(Type.String({ description: 'Application path' })),
      windowId: Type.Optional(Type.Number({ description: 'CG window id from desktop_windows' })),
      maxNodes: Type.Optional(Type.Number({ minimum: 10, maximum: 200, description: 'Max accessibility nodes' })),
      maxChars: Type.Optional(Type.Number({ minimum: 1000, maximum: 40000, description: 'Soft JSON size budget' })),
    }),
    replay: 'safe',
    async execute(args, api) {
      const snapshot = await captureAllowedDesktopSnapshot({
        appName: args.appName,
        bundleId: args.bundleId,
        path: args.path,
        windowId: args.windowId,
        maxNodes: args.maxNodes,
        maxChars: args.maxChars,
        sessionId: sessionIdFromApi(api),
      });
      const summary = [
        `app: ${snapshot.appName || ''}`,
        `windowId: ${snapshot.windowId ?? ''}`,
        `title: ${snapshot.title || ''}`,
        `nodes: ${snapshot.nodeCount || 0}${snapshot.truncated ? ' (truncated)' : ''}`,
        JSON.stringify({ nodes: snapshot.nodes }, null, 2),
      ].join('\n');
      return textResult(summary, snapshot);
    },
  });

  const desktopScreenshot = defineTool({
    name: 'desktop_screenshot',
    description: 'Capture an allowed application window and its available same-app panels. windowId is required and must belong to the allowed app; full-screen capture is refused. Large captures may be scaled down before return.',
    parameters: Type.Object({
      appName: Type.Optional(Type.String({ description: 'Running application name' })),
      bundleId: Type.Optional(Type.String({ description: 'Application bundle id' })),
      path: Type.Optional(Type.String({ description: 'Application path' })),
      windowId: Type.Number({ description: 'CG window id from desktop_windows (required)' }),
    }),
    replay: 'safe',
    async execute(args, api) {
      const shot = await captureAllowedDesktopScreenshot({
        appName: args.appName,
        bundleId: args.bundleId,
        path: args.path,
        windowId: args.windowId,
        sessionId: sessionIdFromApi(api),
      });
      return {
        output: screenshotBlocks(shot, shot.appName),
        details: {
          appName: shot.appName,
          bundleId: shot.bundleId,
          ...screenshotMetadata(shot),
        },
      };
    },
  });

  const desktopClick = defineTool({
    name: 'desktop_click',
    description: 'Press a control by its desktop_snapshot ref/path in the specified window. On macOS AXPress can work in the background. Use windowId and window-relative coordinates for visual clicks. The macOS Virtual Stage handles supported background clicks. A point on the main image automatically binds its visible popup. For a separate popup image pass popupWindowId with its own coordinates.',
    parameters: Type.Object({
      appName: Type.Optional(Type.String({ description: 'Running application name' })),
      bundleId: Type.Optional(Type.String({ description: 'Application bundle id' })),
      path: Type.Optional(Type.String({ description: 'Application path' })),
      windowId: Type.Number({ description: 'Window id from desktop_windows (required)' }),
      popupWindowId: Type.Optional(Type.Number({ description: 'For coordinates from a separately returned popup image, use its window ID. For the main image, omit this field.' })),
      chatTarget,
      ref: Type.Optional(Type.String({ description: 'Node ref from desktop_snapshot, e.g. n12' })),
      elementPath: Type.Optional(Type.String({ description: 'Node path from desktop_snapshot, e.g. 1/2/3' })),
      normX: Type.Optional(Type.Number({ minimum: 0, maximum: 1000, description: 'Window-normalized X (0..1000)' })),
      normY: Type.Optional(Type.Number({ minimum: 0, maximum: 1000, description: 'Window-normalized Y (0..1000)' })),
      rx: Type.Optional(Type.Number({ description: 'Window-relative X offset from top-left' })),
      ry: Type.Optional(Type.Number({ description: 'Window-relative Y offset from top-left' })),
      imageWidth: Type.Optional(Type.Number({ description: 'Screenshot pixel width if rx/ry are screenshot pixels' })),
      imageHeight: Type.Optional(Type.Number({ description: 'Screenshot pixel height if rx/ry are screenshot pixels' })),
      x: Type.Optional(Type.Number({ description: 'Absolute screen X inside the window' })),
      y: Type.Optional(Type.Number({ description: 'Absolute screen Y inside the window' })),
      button: Type.Optional(Type.String({ description: 'left (default) or right' })),
      double: Type.Optional(Type.Boolean({ description: 'Double click when true' })),
    }),
    replay: 'unsafe',
    async execute(args, api) {
      const result = await clickAllowedDesktop({
        appName: args.appName,
        bundleId: args.bundleId,
        path: args.path,
        windowId: args.windowId,
        popupWindowId: args.popupWindowId,
        ref: args.ref,
        elementPath: args.elementPath,
        normX: args.normX,
        normY: args.normY,
        rx: args.rx,
        ry: args.ry,
        imageWidth: args.imageWidth,
        imageHeight: args.imageHeight,
        x: args.x,
        y: args.y,
        button: args.button,
        double: args.double,
        sessionId: sessionIdFromApi(api),
      });
      return textResult(
        result.method === 'AXPress' ? `已操作 ${result.appName || ''} #${result.windowId} 的控件 ${result.ref || result.path}（AXPress）`
          : `clicked ${result.appName || ''} #${result.windowId} @${result.x},${result.y}${result.ref ? ` (${result.ref})` : ''}`,
        result,
      );
    },
  });


  const desktopType = defineTool({
    name: 'desktop_type',
    description: 'Enter literal text in an allowed window. For search or autocomplete, use searchField:true with submit:false to return the suggestions and window image with the typing result. A writable macOS field identified by snapshot ref can accept a verified background replacement with clear:true. submit:true presses Enter once.',
    parameters: Type.Object({
      appName: Type.Optional(Type.String({ description: 'Running application name' })),
      bundleId: Type.Optional(Type.String({ description: 'Application bundle id' })),
      path: Type.Optional(Type.String({ description: 'Application path' })),
      windowId: Type.Number({ description: 'Window id from desktop_windows (required)' }),
      text: Type.String({ description: 'Text to type (max 2000 chars; Chinese/Unicode/newlines supported)' }),
      chatTarget,
      searchField,
      ref: Type.Optional(Type.String({ description: 'Node ref from desktop_snapshot to focus first, e.g. n12' })),
      elementPath: Type.Optional(Type.String({ description: 'Node path from desktop_snapshot to focus first, e.g. 1/2/3' })),
      normX: Type.Optional(Type.Number({ minimum: 0, maximum: 1000, description: 'Optional window-normalized X to click before typing' })),
      normY: Type.Optional(Type.Number({ minimum: 0, maximum: 1000, description: 'Optional window-normalized Y to click before typing' })),
      rx: Type.Optional(Type.Number({ description: 'Optional window-relative X to click before typing' })),
      ry: Type.Optional(Type.Number({ description: 'Optional window-relative Y to click before typing' })),
      clear: Type.Optional(Type.Boolean({ description: 'Select all and clear field before typing' })),
      submit: Type.Optional(Type.Boolean({ description: 'Press Enter right after typing' })),
    }),
    replay: 'unsafe',
    async execute(args, api) {
      const result = await typeAllowedDesktop({
        appName: args.appName,
        bundleId: args.bundleId,
        path: args.path,
        windowId: args.windowId,
        text: args.text,
        searchField: args.searchField === true,
        ref: args.ref,
        elementPath: args.elementPath,
        normX: args.normX,
        normY: args.normY,
        rx: args.rx,
        ry: args.ry,
        clear: args.clear,
        submit: args.submit,
        sessionId: sessionIdFromApi(api),
      });
      const where = result.ref
        ? ` → ${result.ref}`
        : (result.mode === 'focused' ? ' (focused)' : '');
      const summary = `${result.appName || ''} #${result.windowId}${where} · ${formatTypeOutcome(result)}`;
      const details = {
        ok: result.ok,
        appName: result.appName,
        bundleId: result.bundleId,
        windowId: result.windowId,
        title: result.title || '',
        chars: result.chars,
        method: result.method,
        submitted: Boolean(result.submitted),
        ...(typeof result.valueVerified === 'boolean' ? { valueVerified: result.valueVerified } : {}),
        ref: result.ref || '',
        path: result.path || '',
        role: result.role || '',
        name: result.name || '',
        mode: result.mode || '',
        ...(result.screenshot?.data ? { screenshot: screenshotMetadata(result.screenshot) } : {}),
        ...(result.screenshotError ? { screenshotError: result.screenshotError } : {}),
      };
      if (result.screenshot?.data) return { output: screenshotBlocks(result.screenshot, summary), details };
      return textResult(result.screenshotError ? `${summary}\n截图失败：${result.screenshotError.message}` : summary, details);
    },
  });

  const desktopScroll = defineTool({
    name: 'desktop_scroll',
    description: 'Scroll inside one allowed application window. windowId is required. Prefer direction (up/down/left/right) + amount (line ticks, default 3, max 40), or provide signed dx/dy line deltas. Optional ref/elementPath/x/y set the scroll point; otherwise uses the window center. Requires Accessibility.',
    parameters: Type.Object({
      appName: Type.Optional(Type.String({ description: 'Running application name' })),
      bundleId: Type.Optional(Type.String({ description: 'Application bundle id' })),
      path: Type.Optional(Type.String({ description: 'Application path' })),
      windowId: Type.Number({ description: 'CG window id from desktop_windows (required)' }),
      direction: Type.Optional(Type.String({ description: 'up | down | left | right (default down when dx/dy omitted)' })),
      amount: Type.Optional(Type.Number({ description: 'Positive line ticks when using direction (default 3, max 40)' })),
      dx: Type.Optional(Type.Number({ description: 'Signed horizontal line delta (positive = left)' })),
      dy: Type.Optional(Type.Number({ description: 'Signed vertical line delta (positive = up)' })),
      ref: Type.Optional(Type.String({ description: 'Node ref from desktop_snapshot for scroll point' })),
      elementPath: Type.Optional(Type.String({ description: 'Node path from desktop_snapshot for scroll point' })),
      x: Type.Optional(Type.Number({ description: 'Absolute screen X inside the window' })),
      y: Type.Optional(Type.Number({ description: 'Absolute screen Y inside the window' })),
    }),
    replay: 'unsafe',
    async execute(args, api) {
      const result = await scrollAllowedDesktop({
        appName: args.appName,
        bundleId: args.bundleId,
        path: args.path,
        windowId: args.windowId,
        direction: args.direction,
        amount: args.amount,
        dx: args.dx,
        dy: args.dy,
        ref: args.ref,
        elementPath: args.elementPath,
        x: args.x,
        y: args.y,
        sessionId: sessionIdFromApi(api),
      });
      const where = result.ref
        ? ` → ${result.ref}`
        : ` @${result.x},${result.y}`;
      return textResult(
        `scrolled ${result.direction || ''} ${result.amount || 0} in ${result.appName || ''} #${result.windowId}${where}`,
        result,
      );
    },
  });

  const desktopDrag = defineTool({
    name: 'desktop_drag',
    description: 'Drag inside one allowed application window from a start point to an end point. windowId is required. Start: ref/elementPath or x/y. End: toRef/toElementPath or toX/toY. Both points must lie inside the window. Refuses secure/password start targets, zero-length drags, and oversized distance. Optional steps (default 12, max 40). Requires Accessibility.',
    parameters: Type.Object({
      appName: Type.Optional(Type.String({ description: 'Running application name' })),
      bundleId: Type.Optional(Type.String({ description: 'Application bundle id' })),
      path: Type.Optional(Type.String({ description: 'Application path' })),
      windowId: Type.Number({ description: 'CG window id from desktop_windows (required)' }),
      ref: Type.Optional(Type.String({ description: 'Start node ref from desktop_snapshot' })),
      elementPath: Type.Optional(Type.String({ description: 'Start node path from desktop_snapshot' })),
      x: Type.Optional(Type.Number({ description: 'Start absolute screen X inside the window' })),
      y: Type.Optional(Type.Number({ description: 'Start absolute screen Y inside the window' })),
      toRef: Type.Optional(Type.String({ description: 'End node ref from desktop_snapshot' })),
      toElementPath: Type.Optional(Type.String({ description: 'End node path from desktop_snapshot' })),
      toX: Type.Optional(Type.Number({ description: 'End absolute screen X inside the window' })),
      toY: Type.Optional(Type.Number({ description: 'End absolute screen Y inside the window' })),
      steps: Type.Optional(Type.Number({ description: 'Intermediate drag steps (default 12, max 40)' })),
    }),
    replay: 'unsafe',
    async execute(args, api) {
      const result = await dragAllowedDesktop({
        appName: args.appName,
        bundleId: args.bundleId,
        path: args.path,
        windowId: args.windowId,
        ref: args.ref,
        elementPath: args.elementPath,
        x: args.x,
        y: args.y,
        toRef: args.toRef,
        toElementPath: args.toElementPath,
        toX: args.toX,
        toY: args.toY,
        steps: args.steps,
        sessionId: sessionIdFromApi(api),
      });
      return textResult(
        `dragged ${result.appName || ''} #${result.windowId} @${result.fromX},${result.fromY}→${result.toX},${result.toY}`,
        result,
      );
    },
  });

  const desktopHotkey = defineTool({
    name: 'desktop_hotkey',
    description: 'Press a keyboard shortcut inside one allowed application window. windowId is required. On macOS use the Virtual Stage for a background window. Provide key (single character or named key: enter/tab/escape/space/delete/arrows/home/end/pageup/pagedown/f1-f12) and optional modifiers [command|cmd, shift, option|alt, control|ctrl]. key may also be a chord like "cmd+s". Blocks dangerous system chords (⌘Q, ⌘⌥Esc, ⌃⌘Q, ⌘Tab, ⌘Space). Requires Accessibility.',
    parameters: Type.Object({
      appName: Type.Optional(Type.String({ description: 'Running application name' })),
      bundleId: Type.Optional(Type.String({ description: 'Application bundle id' })),
      path: Type.Optional(Type.String({ description: 'Application path' })),
      windowId: Type.Number({ description: 'CG window id from desktop_windows (required)' }),
      key: Type.String({ description: 'Key to press, or chord like cmd+s' }),
      chatTarget,
      modifiers: Type.Optional(Type.Array(Type.String(), { description: 'Modifiers: command/cmd, shift, option/alt, control/ctrl' })),
    }),
    replay: 'unsafe',
    async execute(args, api) {
      const result = await hotkeyAllowedDesktop({
        appName: args.appName,
        bundleId: args.bundleId,
        path: args.path,
        windowId: args.windowId,
        key: args.key,
        modifiers: args.modifiers,
        sessionId: sessionIdFromApi(api),
      });
      return textResult(
        `hotkey ${result.chord || result.key || ''} on ${result.appName || ''} #${result.windowId}`,
        result,
      );
    },
  });

  const failureHandling = createDesktopFailureHandling(durable);
  function bindToRun(tool) {
    const wrapped = failureHandling.wrap(tool);
    if (!observeDesktopRun) return wrapped;
    return {
      ...wrapped,
      execute(args, api, context) {
        return withDesktopControlRun(sessionIdFromApi(api),
          observer => observeDesktopRun(api.conversationId, observer),
          () => wrapped.execute(args, api, context), context.abortSignal);
      },
    };
  }
  return defineExtension({
    name: 'studio-desktop-control',
    sections: [
      durable.section('studio-desktop-workflow', ({ agent }) => {
        if (!agent.tools.some((tool) => tool.name === 'desktop_act' || tool.name === 'desktop_type')) return undefined;
        return [
          'For general desktop tasks, connect to the app with desktop_launch when available, then reuse its windowId. Use the image already returned to choose the next batch.',
          'Keep the current app and Space in place on macOS. Reuse the main windowId on the Virtual Stage, including in Mission Control. Only the user can bring the app forward with the preview button. Use desktop tools for all desktop interaction; a shell, clipboard command or AppleScript cannot be used as a fallback.',
          'For search and autocomplete, use desktop_act with searchField:true to focus the field and type once in the same batch, or desktop_type with searchField:true if already focused. Leave submit and settleMs unset to observe the dropdown in the same call. If the query is already there, observe the same window without another click or keystroke.',
          'For messaging tasks, inspect the launch image first. If the requested chat is already open, skip search. If its full name is visible in the conversation list, click that row and verify the header. Otherwise search for the literal query with clear:true on the type step. The query text alone does not establish that results appeared or that there were no matches. If the query is already visible, select the matching result only when you can read the complete row. On the main image, click the result once in main-image coordinates. For a separate popup image, use its popupWindowId and its own normalized coordinates. Make the result click a single action, then check the opened conversation.',
          'If results are unreadable, try one targeted observation (a new screenshot after rendering, or an accessible search-result ref). If still unavailable, stop and ask for help. An absent popup image or the search field text alone cannot establish whether a result exists. Never pick by pressing Enter blindly, repeat the query, or open a similar name.',
          'Before composing or sending to a named recipient, set chatTarget.requested to the exact name in the user request and chatTarget.visibleTitle to the complete selected chat header visible in the latest screenshot or accessible label. If the names differ beyond a trailing member count, stop and ask which chat the user intends. The search field, a suggested result and a previous chat title cannot verify the newly opened conversation.',
          'Inspect the full composer and attachment strip in the same window image used to verify the chat. Stop and preserve any pre-existing text, image thumbnail or file, including when text could be appended beside it. If the composer or attachment area is unclear, or Send is already enabled with no apparent content, stop. Report this observation with chatTarget.composer before any editing, paste or send. Use prepared only when the visible draft consists entirely of text or media deliberately added for this request after an empty check.',
          'For supplied text, once the recipient and empty composer are verified, batch focusing the composer, literal typing, and a single requested submission. For multiline text or an explicitly requested clipboard item, enter it separately with no submission and inspect the visible lines and attachments before sending. Use the returned screenshot to check the outgoing text once. An updated conversation preview matching the message and cleared composer suffices to report local sending. If the evidence is uncertain, report the uncertainty and stop.',
        ].join('\n');
      }),
    ],
    hooks: failureHandling.hooks,
    tools: [
      desktopStatus,
      desktopApps,
      desktopWindows,
      desktopLaunch,
      desktopAct,
      desktopSnapshot,
      desktopScreenshot,
      desktopClick,
      desktopType,
      desktopScroll,
      desktopDrag,
      desktopHotkey,
    ].map(bindToRun),
  });
}

module.exports = {
  createDesktopControlTools,
};
