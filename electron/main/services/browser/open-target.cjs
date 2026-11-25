/**
 * Resolve Agent/browser open targets and keep ordinary previews in the
 * workbench when the user prefers it over the system browser.
 *
 * Preferences apply to *all* matching links:
 * - webLinkOpenTarget  → http(s) links
 * - localLinkOpenTarget → localhost / loopback / file:// / local paths
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getBrowserPreferences } = require('./settings.cjs');

function stripQuotes(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function looksLikeHtmlPath(value) {
  const text = stripQuotes(value);
  if (!text) return false;
  try {
    if (/^file:/i.test(text)) {
      const filePath = decodeURIComponent(new URL(text).pathname || '');
      return /\.html?$/i.test(filePath);
    }
  } catch {
    // Fall through.
  }
  return /\.html?$/i.test(text.split(/[?#]/)[0] || '');
}

function isLoopbackOrLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host.endsWith('.localhost');
}

function classifyOpenTarget(value) {
  const text = stripQuotes(value);
  if (!text) return 'none';
  if (text === 'about:blank') return 'web';
  try {
    if (/^https?:\/\//i.test(text)) {
      const parsed = new URL(text);
      return isLoopbackOrLocalHost(parsed.hostname) ? 'local' : 'web';
    }
    if (/^file:/i.test(text)) return 'local';
  } catch {
    // Fall through to path heuristics.
  }
  // Absolute / relative filesystem paths and bare localhost hosts.
  if (text.startsWith('/') || text.startsWith('~') || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('.')) {
    return 'local';
  }
  if (/^localhost(?::\d+)?(?:[/?#].*)?$/i.test(text) || /^127\.0\.0\.1(?::\d+)?(?:[/?#].*)?$/i.test(text)) {
    return 'local';
  }
  if (/^https?:\/\//i.test(text)) return 'web';
  return 'none';
}

/**
 * Turn a browser_open argument into a loadable URL.
 * Accepts http(s), about:blank, file:// HTML, or an absolute/relative HTML path.
 */
function resolveBrowserOpenUrl(input, cwd) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('url 不能为空');
  if (raw === 'about:blank' || /^https?:\/\//i.test(raw)) return raw;

  if (/^file:/i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error('本地文件 URL 无效');
    }
    if (parsed.protocol !== 'file:') throw new Error('只支持 file:// 本地 HTML');
    const filePath = decodeURIComponent(parsed.pathname || '');
    if (!/\.html?$/i.test(filePath)) {
      throw new Error('工作台浏览器的本地文件预览只支持 .html / .htm');
    }
    return parsed.href;
  }

  const candidate = stripQuotes(raw);
  if (/\.html?$/i.test(candidate.split(/[?#]/)[0] || '')) {
    const absolute = path.isAbsolute(candidate)
      ? path.normalize(candidate)
      : path.resolve(String(cwd || process.cwd()), candidate);
    if (!/\.html?$/i.test(absolute)) {
      throw new Error('工作台浏览器的本地文件预览只支持 .html / .htm');
    }
    return pathToFileURL(absolute).href;
  }

  // Bare localhost hosts typed without a scheme.
  if (/^localhost(?::\d+)?(?:[/?#].*)?$/i.test(candidate)
    || /^127\.0\.0\.1(?::\d+)?(?:[/?#].*)?$/i.test(candidate)
    || (
      /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/i.test(candidate)
      // Do not treat bare filenames like notes.md / report.pdf as hostnames.
      && !/\.(html?|md|markdown|pdf|png|jpe?g|gif|webp|svg|css|js|mjs|cjs|ts|tsx|jsx|json|txt|csv|xlsx?|docx?|pptx?|zip|tgz|gz|wasm|map)$/i.test(
        candidate.split(/[/?#:]/)[0] || '',
      )
    )) {
    return `http://${candidate}`;
  }

  throw new Error('请提供 http(s) 链接、about:blank，或本地 HTML 文件路径');
}

/**
 * Detect shell commands that open a link/file in the OS browser (or via
 * Playwright) instead of Studio's workbench / in-app preview.
 */
function isSystemBrowserOpenCommand(command) {
  const text = String(command || '').trim();
  if (!text) return false;

  const hasOpenHelper = /(?:^|[;&|\n\r(`])\s*(?:open|xdg-open|gio\s+open|start)\b/i.test(text);
  const hasBrowserApp = /\b(?:google\s*chrome|chromium|microsoft\s*edge|safari|firefox|brave)\b/i.test(text);
  const hasAutomation = /\b(?:playwright|puppeteer|chromedriver)\b/i.test(text);

  if (!hasOpenHelper && !hasBrowserApp && !hasAutomation) return false;

  // Any http(s) / file / localhost / local path argument.
  if (/https?:\/\//i.test(text) || /file:\/\//i.test(text)) return true;
  if (/\blocalhost\b/i.test(text) || /\b127\.0\.0\.1\b/i.test(text)) return true;
  if (looksLikeHtmlPath(text)) return true;
  // `open /abs/path` or `open ./rel` — treat as local open via OS.
  if (hasOpenHelper && /(?:^|\s)(?:~\/|\/|\.\/|\.\.\/|[A-Za-z]:[\\/])\S+/.test(text)) return true;
  // Browser app launched with a path-like arg.
  if (hasBrowserApp && /(?:^|\s)(?:~\/|\/|\.\/|\.\.\/|[A-Za-z]:[\\/])\S+/.test(text)) return true;
  return false;
}

/** @deprecated use isSystemBrowserOpenCommand */
function isSystemHtmlOpenCommand(command) {
  return isSystemBrowserOpenCommand(command);
}

function preferWorkbenchForKind(kind, preferences = getBrowserPreferences()) {
  if (kind === 'web') {
    return String(preferences?.webLinkOpenTarget || 'workbench') !== 'system';
  }
  if (kind === 'local') {
    return String(preferences?.localLinkOpenTarget || 'workbench') !== 'system';
  }
  return true;
}

function preferWorkbenchForLocalHtml(preferences = getBrowserPreferences()) {
  return preferWorkbenchForKind('local', preferences);
}

function preferWorkbenchForWeb(preferences = getBrowserPreferences()) {
  return preferWorkbenchForKind('web', preferences);
}

/**
 * Single decision for where a URL/path should open.
 * target is always `workbench` or `system` (never a third UI mode).
 */
function resolveOpenDestination(value, preferences = getBrowserPreferences()) {
  const kind = classifyOpenTarget(value);
  if (kind === 'none') {
    return { kind: 'none', target: 'workbench' };
  }
  const workbench = preferWorkbenchForKind(kind, preferences);
  return { kind, target: workbench ? 'workbench' : 'system' };
}

/** Pages the workbench browser can load (vs in-app file preview). */
function isWorkbenchBrowsableTarget(value) {
  const text = stripQuotes(value);
  if (!text) return false;
  if (text === 'about:blank' || /^https?:\/\//i.test(text)) return true;
  if (/^file:/i.test(text) || looksLikeHtmlPath(text)) return true;
  if (/^localhost(?::\d+)?(?:[/?#].*)?$/i.test(text) || /^127\.0\.0\.1(?::\d+)?(?:[/?#].*)?$/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * Whether a bash open command should be blocked under current preferences.
 */
function shouldBlockSystemBrowserOpen(command, preferences = getBrowserPreferences()) {
  // Master enforcement switch from Settings → 浏览器.
  if (preferences && preferences.linkOpenBlockExternal === false) return false;
  if (!isSystemBrowserOpenCommand(command)) return false;
  const text = String(command || '');

  // Classify by the strongest signal in the command.
  let kind = 'none';
  if (/https?:\/\//i.test(text)) {
    try {
      const match = text.match(/https?:\/\/[^\s'"]+/i);
      if (match) kind = classifyOpenTarget(match[0]);
    } catch {
      kind = 'web';
    }
  } else if (/file:\/\//i.test(text) || looksLikeHtmlPath(text) || /\blocalhost\b/i.test(text) || /\b127\.0\.0\.1\b/i.test(text)) {
    kind = 'local';
  } else if (/(?:^|\s)(?:~\/|\/|\.\/|\.\.\/|[A-Za-z]:[\\/])\S+/.test(text)) {
    kind = 'local';
  } else {
    // Browser app with no clear target — still respect web preference.
    kind = 'web';
  }

  return preferWorkbenchForKind(kind, preferences);
}

function systemBrowserOpenBlockMessage(command, preferences = getBrowserPreferences()) {
  const web = preferWorkbenchForWeb(preferences) ? '工作台浏览器' : '系统浏览器';
  const local = preferWorkbenchForLocalHtml(preferences) ? '应用内（浏览器或预览）' : '系统默认应用';
  return [
    '已拦截：设置 → 浏览器 中「拦截外部打开」已开启，且打开位置要求在 Studio 内。',
    `网页链接：${web}；本地链接：${local}。`,
    '请用 browser_open 打开网页/localhost/可浏览页面；其他本地文件用应用内预览。不要 bash open / Playwright / 用终端启动系统 Chrome。',
    '已配置的 MCP（例如 Chrome DevTools MCP）不受此 bash 拦截；普通预览仍优先工作台 browser_open。',
    '若需要系统打开：到设置 → 浏览器，关闭「拦截外部打开」，或把对应「打开位置」改为系统。',
    command ? `原命令：${String(command).slice(0, 240)}` : '',
  ].filter(Boolean).join('\n');
}

/** @deprecated */
function systemHtmlOpenBlockMessage(command) {
  return systemBrowserOpenBlockMessage(command);
}

function browserPreferenceInstructions(preferences = getBrowserPreferences()) {
  if (preferences && preferences.linkOpenInstructAgent === false) {
    return '';
  }
  const web = preferWorkbenchForWeb(preferences) ? 'workbench' : 'system';
  const local = preferWorkbenchForLocalHtml(preferences) ? 'workbench' : 'system';
  const lines = [
    'Link opening is controlled only by Studio settings (Settings → Browser), for all web and local links:',
    `- http(s) web links → ${web === 'workbench' ? 'browser_open in the right-side workbench browser' : 'system browser (settings: system)'}`,
    `- local links (localhost, file://, any local path) → ${local === 'workbench' ? 'open inside Studio (browser for browsable pages; in-app preview for other files)' : 'system default app / system browser (settings: system)'}`,
  ];
  if (preferences?.linkOpenBlockExternal !== false && (web === 'workbench' || local === 'workbench')) {
    lines.push('Do not use bash open/xdg-open, Playwright, Puppeteer, or launching system Chrome via the shell when the matching open-target preference is workbench. Changing settings is the only way to allow those shell opens.');
  } else if (preferences?.linkOpenBlockExternal === false) {
    lines.push('External open blocking is disabled in settings; still follow the open-target preferences above.');
  }
  lines.push('browser_open accepts http(s), about:blank, file:// pages, or a local page path the workbench browser can load.');
  lines.push('MCP tools (including a configured Chrome DevTools MCP) are not blocked by this bash intercept; use those MCP tools when the task needs external Chrome DevTools, and use Studio browser_open for ordinary workbench previews.');
  return lines.join(' ');
}

module.exports = {
  browserPreferenceInstructions,
  classifyOpenTarget,
  isLoopbackOrLocalHost,
  isSystemBrowserOpenCommand,
  isSystemHtmlOpenCommand,
  isWorkbenchBrowsableTarget,
  looksLikeHtmlPath,
  preferWorkbenchForKind,
  preferWorkbenchForLocalHtml,
  preferWorkbenchForWeb,
  resolveBrowserOpenUrl,
  resolveOpenDestination,
  shouldBlockSystemBrowserOpen,
  systemBrowserOpenBlockMessage,
  systemHtmlOpenBlockMessage,
};
