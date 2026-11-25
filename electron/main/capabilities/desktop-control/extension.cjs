/**
 * Desktop observation + constrained click/type/scroll/drag/hotkey tools (Codex Computer Use–style).
 */
const toolSchema = require('../../runtime/tool-schema.cjs');
const {
  getDesktopControlStatus,
  listDesktopApps,
  listDesktopWindows,
  captureAllowedDesktopSnapshot,
  captureAllowedDesktopScreenshot,
  clickAllowedDesktop,
  typeAllowedDesktop,
  scrollAllowedDesktop,
  dragAllowedDesktop,
  hotkeyAllowedDesktop,
} = require('../../services/desktop-control/index.cjs');

function textResult(text, details) {
  const payload = { output: [{ type: 'text', text: String(text || '') }] };
  if (details !== undefined) payload.details = details;
  return payload;
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
  if (!status.allowAnyApp && !(status.alwaysAllowCount > 0)) missing.push('add always-allow app (or enable allowAnyApp)');
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

function createDesktopControlTools(durable) {
  const { defineExtension, defineTool } = durable;
  const Type = toolSchema;

  const desktopStatus = defineTool({
    name: 'desktop_status',
    description: 'Show whether desktop control is enabled, macOS permissions, supported actions/tools, what is still missing, and a short recent activity log (metadata only: tool/app/window/time; never screenshots, UI text, or typed content). Read-only.',
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
    description: 'List running macOS applications and whether each one is already allowed for desktop observation. Does not return window contents. Requires desktop control enabled; does not require Accessibility (so the agent can suggest apps to allow before full observation is ready).',
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
    async execute(args) {
      const result = await listDesktopWindows({
        appName: args.appName,
        bundleId: args.bundleId,
      });
      const windowLines = (result.windows || []).map((win) => (
        `${win.windowId}\t${win.appName}\t${win.minimized ? 'minimized' : (win.visible === false ? 'hidden' : 'visible')}\t${win.title || '(no title)'}`
      ));
      const skippedLines = (result.skipped || []).map((row) => (
        `${row.decision}\t${row.name}\t${row.reason || ''}`
      ));
      const parts = [];
      parts.push(windowLines.length ? `windows:\n${windowLines.join('\n')}` : 'windows: (none)');
      if (skippedLines.length) parts.push(`skipped:\n${skippedLines.join('\n')}`);
      return textResult(parts.join('\n\n'), result);
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
    async execute(args) {
      const snapshot = await captureAllowedDesktopSnapshot({
        appName: args.appName,
        bundleId: args.bundleId,
        path: args.path,
        windowId: args.windowId,
        maxNodes: args.maxNodes,
        maxChars: args.maxChars,
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
    description: 'Capture a PNG screenshot of one allowed application window. windowId is required and must belong to the allowed app; full-screen capture is refused. Large captures may be scaled down before return.',
    parameters: Type.Object({
      appName: Type.Optional(Type.String({ description: 'Running application name' })),
      bundleId: Type.Optional(Type.String({ description: 'Application bundle id' })),
      path: Type.Optional(Type.String({ description: 'Application path' })),
      windowId: Type.Number({ description: 'CG window id from desktop_windows (required)' }),
    }),
    replay: 'safe',
    async execute(args) {
      const shot = await captureAllowedDesktopScreenshot({
        appName: args.appName,
        bundleId: args.bundleId,
        path: args.path,
        windowId: args.windowId,
      });
      const label = `${shot.appName || 'window'} #${shot.windowId}`;
      return {
        output: [
          { type: 'text', text: `截图：${label}` },
          { type: 'image', mimeType: shot.mimeType, data: shot.data },
        ],
        details: {
          appName: shot.appName,
          bundleId: shot.bundleId,
          windowId: shot.windowId,
          bytes: shot.bytes,
          mimeType: shot.mimeType,
        },
      };
    },
  });

  const desktopClick = defineTool({
    name: 'desktop_click',
    description: 'Click inside one allowed application window. Prefer ref/path from desktop_snapshot; optional x/y must lie inside that window. windowId is required. Refuses secure/password targets, blocked apps, and points outside the window. Requires Accessibility.',
    parameters: Type.Object({
      appName: Type.Optional(Type.String({ description: 'Running application name' })),
      bundleId: Type.Optional(Type.String({ description: 'Application bundle id' })),
      path: Type.Optional(Type.String({ description: 'Application path' })),
      windowId: Type.Number({ description: 'CG window id from desktop_windows (required)' }),
      ref: Type.Optional(Type.String({ description: 'Node ref from desktop_snapshot, e.g. n12' })),
      elementPath: Type.Optional(Type.String({ description: 'Node path from desktop_snapshot, e.g. 1/2/3' })),
      x: Type.Optional(Type.Number({ description: 'Absolute screen X inside the window' })),
      y: Type.Optional(Type.Number({ description: 'Absolute screen Y inside the window' })),
      button: Type.Optional(Type.String({ description: 'left (default) or right' })),
    }),
    replay: 'strict',
    async execute(args) {
      const result = await clickAllowedDesktop({
        appName: args.appName,
        bundleId: args.bundleId,
        path: args.path,
        windowId: args.windowId,
        ref: args.ref,
        elementPath: args.elementPath,
        x: args.x,
        y: args.y,
        button: args.button,
      });
      return textResult(
        `clicked ${result.appName || ''} #${result.windowId} @${result.x},${result.y}${result.ref ? ` (${result.ref})` : ''}`,
        result,
      );
    },
  });


  const desktopType = defineTool({
    name: 'desktop_type',
    description: 'Type plain text into one allowed application window. windowId is required. Optional ref/elementPath from desktop_snapshot click-to-focus first; otherwise types into the current focus after a secure-field probe. Refuses empty text, oversize text (max 2000 chars), unsupported control characters, secure/password targets, and blocked apps. Requires Accessibility. Activity logs never store the typed string—only length and targeting metadata.',
    parameters: Type.Object({
      appName: Type.Optional(Type.String({ description: 'Running application name' })),
      bundleId: Type.Optional(Type.String({ description: 'Application bundle id' })),
      path: Type.Optional(Type.String({ description: 'Application path' })),
      windowId: Type.Number({ description: 'CG window id from desktop_windows (required)' }),
      text: Type.String({ description: 'Plain text to type (max 2000 chars; tab/newline allowed)' }),
      ref: Type.Optional(Type.String({ description: 'Node ref from desktop_snapshot to focus first, e.g. n12' })),
      elementPath: Type.Optional(Type.String({ description: 'Node path from desktop_snapshot to focus first, e.g. 1/2/3' })),
    }),
    replay: 'strict',
    async execute(args) {
      const result = await typeAllowedDesktop({
        appName: args.appName,
        bundleId: args.bundleId,
        path: args.path,
        windowId: args.windowId,
        text: args.text,
        ref: args.ref,
        elementPath: args.elementPath,
      });
      const where = result.ref
        ? ` → ${result.ref}`
        : (result.mode === 'focused' ? ' (focused)' : '');
      return textResult(
        `typed ${result.chars || 0} chars into ${result.appName || ''} #${result.windowId}${where}`,
        {
          ok: result.ok,
          appName: result.appName,
          bundleId: result.bundleId,
          windowId: result.windowId,
          title: result.title || '',
          chars: result.chars,
          ref: result.ref || '',
          path: result.path || '',
          role: result.role || '',
          name: result.name || '',
          mode: result.mode || '',
        },
      );
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
    replay: 'strict',
    async execute(args) {
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
    replay: 'strict',
    async execute(args) {
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
      });
      return textResult(
        `dragged ${result.appName || ''} #${result.windowId} @${result.fromX},${result.fromY}→${result.toX},${result.toY}`,
        result,
      );
    },
  });

  const desktopHotkey = defineTool({
    name: 'desktop_hotkey',
    description: 'Press a keyboard shortcut inside one allowed application window. windowId is required (activates that window first). Provide key (single character or named key: enter/tab/escape/space/delete/arrows/home/end/pageup/pagedown/f1-f12) and optional modifiers [command|cmd, shift, option|alt, control|ctrl]. key may also be a chord like "cmd+s". Blocks dangerous system chords (⌘Q, ⌘⌥Esc, ⌃⌘Q, ⌘Tab, ⌘Space). Requires Accessibility.',
    parameters: Type.Object({
      appName: Type.Optional(Type.String({ description: 'Running application name' })),
      bundleId: Type.Optional(Type.String({ description: 'Application bundle id' })),
      path: Type.Optional(Type.String({ description: 'Application path' })),
      windowId: Type.Number({ description: 'CG window id from desktop_windows (required)' }),
      key: Type.String({ description: 'Key to press, or chord like cmd+s' }),
      modifiers: Type.Optional(Type.Array(Type.String(), { description: 'Modifiers: command/cmd, shift, option/alt, control/ctrl' })),
    }),
    replay: 'strict',
    async execute(args) {
      const result = await hotkeyAllowedDesktop({
        appName: args.appName,
        bundleId: args.bundleId,
        path: args.path,
        windowId: args.windowId,
        key: args.key,
        modifiers: args.modifiers,
      });
      return textResult(
        `hotkey ${result.chord || result.key || ''} on ${result.appName || ''} #${result.windowId}`,
        result,
      );
    },
  });

  return defineExtension({
    name: 'studio-desktop-control',
    tools: [
      desktopStatus,
      desktopApps,
      desktopWindows,
      desktopSnapshot,
      desktopScreenshot,
      desktopClick,
      desktopType,
      desktopScroll,
      desktopDrag,
      desktopHotkey,
    ],
  });
}

module.exports = {
  createDesktopControlTools,
};
