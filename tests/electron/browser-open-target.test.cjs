const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const {
  browserPreferenceInstructions,
  classifyOpenTarget,
  isSystemBrowserOpenCommand,
  isSystemHtmlOpenCommand,
  preferWorkbenchForKind,
  resolveBrowserOpenUrl,
  shouldBlockSystemBrowserOpen,
} = require('../../electron/main/services/browser/open-target.cjs');

test('resolveBrowserOpenUrl accepts http, blank, file URL and absolute HTML path', () => {
  assert.equal(resolveBrowserOpenUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(resolveBrowserOpenUrl('about:blank'), 'about:blank');

  const absolute = path.join('/tmp', 'demo', 'index.html');
  assert.equal(resolveBrowserOpenUrl(absolute), pathToFileURL(absolute).href);

  const relative = resolveBrowserOpenUrl('site/index.html', '/workspace');
  assert.equal(relative, pathToFileURL(path.join('/workspace', 'site/index.html')).href);

  assert.equal(resolveBrowserOpenUrl('localhost:3000/app'), 'http://localhost:3000/app');
  assert.throws(() => resolveBrowserOpenUrl('notes.md'), /HTML/);
  assert.throws(() => resolveBrowserOpenUrl(''), /不能为空/);
});

test('classifyOpenTarget separates web vs all local link kinds', () => {
  assert.equal(classifyOpenTarget('https://example.com'), 'web');
  assert.equal(classifyOpenTarget('http://localhost:5173'), 'local');
  assert.equal(classifyOpenTarget('http://127.0.0.1:8080/x'), 'local');
  assert.equal(classifyOpenTarget('file:///tmp/a.html'), 'local');
  assert.equal(classifyOpenTarget('/tmp/report.pdf'), 'local');
  assert.equal(classifyOpenTarget('./out/index.html'), 'local');
  assert.equal(classifyOpenTarget('localhost:3000'), 'local');
  assert.equal(classifyOpenTarget(''), 'none');
});

test('isSystemBrowserOpenCommand detects OS open helpers and automation for any link', () => {
  assert.equal(isSystemBrowserOpenCommand('open /tmp/a/index.html'), true);
  assert.equal(isSystemBrowserOpenCommand('open -a "Google Chrome" ./out/page.html'), true);
  assert.equal(isSystemBrowserOpenCommand('xdg-open /tmp/x.html'), true);
  assert.equal(isSystemBrowserOpenCommand('npx playwright open /tmp/x.html'), true);
  assert.equal(isSystemBrowserOpenCommand('open https://example.com'), true);
  assert.equal(isSystemBrowserOpenCommand('open http://localhost:3000'), true);
  // All local paths — not HTML-only.
  assert.equal(isSystemBrowserOpenCommand('open /tmp/report.pdf'), true);
  assert.equal(isSystemBrowserOpenCommand('open ./notes.md'), true);
  assert.equal(isSystemBrowserOpenCommand('ls /tmp/x.html'), false);
  assert.equal(isSystemBrowserOpenCommand('cat index.html'), false);
  // Deprecated alias still works.
  assert.equal(isSystemHtmlOpenCommand('open /tmp/a.html'), true);
});

test('shouldBlockSystemBrowserOpen honors workbench prefs for web and local', () => {
  const workbench = { webLinkOpenTarget: 'workbench', localLinkOpenTarget: 'workbench' };
  const systemAll = { webLinkOpenTarget: 'system', localLinkOpenTarget: 'system' };
  const webSystemOnly = { webLinkOpenTarget: 'system', localLinkOpenTarget: 'workbench' };

  assert.equal(shouldBlockSystemBrowserOpen('open https://example.com', workbench), true);
  assert.equal(shouldBlockSystemBrowserOpen('open https://example.com', systemAll), false);
  assert.equal(shouldBlockSystemBrowserOpen('open https://example.com', webSystemOnly), false);

  assert.equal(shouldBlockSystemBrowserOpen('open /tmp/a.html', workbench), true);
  assert.equal(shouldBlockSystemBrowserOpen('open /tmp/report.pdf', workbench), true);
  assert.equal(shouldBlockSystemBrowserOpen('open /tmp/report.pdf', systemAll), false);
  assert.equal(shouldBlockSystemBrowserOpen('open http://localhost:3000', workbench), true);
  assert.equal(shouldBlockSystemBrowserOpen('ls /tmp', workbench), false);

  assert.equal(
    shouldBlockSystemBrowserOpen('open https://example.com', {
      ...workbench,
      linkOpenBlockExternal: false,
    }),
    false,
  );
});

test('preferWorkbenchForKind and preference instructions cover all link classes', () => {
  assert.equal(preferWorkbenchForKind('web', { webLinkOpenTarget: 'workbench' }), true);
  assert.equal(preferWorkbenchForKind('local', { localLinkOpenTarget: 'system' }), false);

  const text = browserPreferenceInstructions({
    webLinkOpenTarget: 'workbench',
    localLinkOpenTarget: 'workbench',
    linkOpenInstructAgent: true,
    linkOpenBlockExternal: true,
  });
  assert.match(text, /browser_open/);
  assert.match(text, /in-app preview/i);

  assert.equal(browserPreferenceInstructions({
    webLinkOpenTarget: 'workbench',
    localLinkOpenTarget: 'workbench',
    linkOpenInstructAgent: false,
  }), '');
});


test('resolveOpenDestination is the single settings→target decision', () => {
  const {
    resolveOpenDestination,
    isWorkbenchBrowsableTarget,
  } = require('../../electron/main/services/browser/open-target.cjs');

  assert.deepEqual(
    resolveOpenDestination('https://example.com', { webLinkOpenTarget: 'workbench', localLinkOpenTarget: 'workbench' }),
    { kind: 'web', target: 'workbench' },
  );
  assert.deepEqual(
    resolveOpenDestination('https://example.com', { webLinkOpenTarget: 'system', localLinkOpenTarget: 'workbench' }),
    { kind: 'web', target: 'system' },
  );
  assert.deepEqual(
    resolveOpenDestination('/tmp/a.pdf', { webLinkOpenTarget: 'workbench', localLinkOpenTarget: 'workbench' }),
    { kind: 'local', target: 'workbench' },
  );
  assert.deepEqual(
    resolveOpenDestination('http://localhost:3000', { webLinkOpenTarget: 'system', localLinkOpenTarget: 'workbench' }),
    { kind: 'local', target: 'workbench' },
  );

  assert.equal(isWorkbenchBrowsableTarget('https://example.com'), true);
  assert.equal(isWorkbenchBrowsableTarget('/tmp/a.html'), true);
  assert.equal(isWorkbenchBrowsableTarget('/tmp/a.pdf'), false);
});

test('block message and instructions never offer chat-wording bypass', () => {
  const {
    systemBrowserOpenBlockMessage,
    browserPreferenceInstructions,
  } = require('../../electron/main/services/browser/open-target.cjs');
  const message = systemBrowserOpenBlockMessage('open https://example.com', {
    webLinkOpenTarget: 'workbench',
    localLinkOpenTarget: 'workbench',
    linkOpenBlockExternal: true,
  });
  assert.doesNotMatch(message, /用户明确要求/);
  assert.match(message, /设置 → 浏览器/);

  const instructions = browserPreferenceInstructions({
    webLinkOpenTarget: 'workbench',
    localLinkOpenTarget: 'workbench',
    linkOpenInstructAgent: true,
    linkOpenBlockExternal: true,
  });
  assert.doesNotMatch(instructions, /user asked/i);
  assert.match(instructions, /settings/i);
  assert.match(instructions, /MCP/);
});

test('bash intercept does not apply to non-bash tool names conceptually', () => {
  // Hook only runs for call.name === 'bash'; MCP tools are separate registrations.
  assert.equal(shouldBlockSystemBrowserOpen(''), false);
  assert.equal(isSystemBrowserOpenCommand('mcp chrome devtools navigate'), false);
});
