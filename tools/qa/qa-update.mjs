/**
 * Visual QA for the desktop updater surface.
 *
 * This route mounts the real UpdateDialog rather than a copied fixture, then
 * checks every important state in light, dark and narrow layouts. It does not
 * call Electron or GitHub.
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const output = new URL('../../.qa/screenshots/updates/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.route('**/update-preview', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="fixture"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/src/styles/tokens.css');
      await import('/src/styles/palette.css');
      await import('/src/styles/dsh-scrollbar.css');
      await import('/src/app.css');
      const React = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
      const { UpdateDialog } = await import('/src/components/UpdateDialog.tsx');

      const states = {
        idle: { currentVersion: '0.0.3', state: 'idle' },
        checking: { currentVersion: '0.0.3', state: 'checking' },
        available: {
          currentVersion: '0.0.3',
          latestVersion: '0.0.4',
          state: 'available',
          releaseName: 'Quiet updates',
          releaseNotes: '• 新版本在后台检查，释放你的等待时间。\\n• 下载完成后由你决定何时重启。\\n• 修复菜单栏会话结果偶尔无法定位的问题。\\n• 统一亮色与暗色主题下的边框和状态颜色。',
          publishedAt: '2026-10-29T06:14:39.130Z',
          progress: 0
        },
        downloading: {
          currentVersion: '0.0.3',
          latestVersion: '0.0.4',
          state: 'downloading',
          releaseName: 'Quiet updates',
          releaseNotes: '• 后台检查与下载进度。\\n• 更稳定的菜单栏会话入口。',
          publishedAt: '2026-10-29T06:14:39.130Z',
          progress: 42,
          transferred: 68800000,
          total: 161000000,
          bytesPerSecond: 8300000
        },
        downloaded: {
          currentVersion: '0.0.3',
          latestVersion: '0.0.4',
          state: 'downloaded',
          releaseName: 'Quiet updates',
          releaseNotes: '• 后台检查与下载进度。\\n• 更稳定的菜单栏会话入口。\\n• 全新的应用内更新体验。',
          publishedAt: '2026-10-29T06:14:39.130Z',
          progress: 100,
          transferred: 161000000,
          total: 161000000
        },
        error: {
          currentVersion: '0.0.3',
          state: 'error',
          error: '无法连接 GitHub Releases，请检查网络后重试。'
        },
        'up-to-date': { currentVersion: '0.0.3', latestVersion: '0.0.3', state: 'up-to-date' },
        unsupported: {
          currentVersion: '0.0.3',
          state: 'unsupported',
          error: '开发模式不会连接 Release 服务。请使用打包后的 Pi Studio 检查更新。'
        }
      };

      const root = createRoot(document.getElementById('fixture'));
      window.__setUpdateState = (name, theme = 'light') => {
        document.documentElement.dataset.theme = theme;
        const snapshot = structuredClone(states[name]);
        root.render(React.createElement(UpdateDialog, {
          key: name + theme,
          snapshot,
          onClose: () => {},
          onCheck: async () => {},
          onDownload: async () => {},
          onInstall: async () => {}
        }));
      };
      window.__setUpdateState('available');
    </script></body></html>`,
  }));

  await page.goto('http://127.0.0.1:5180/update-preview', { waitUntil: 'domcontentloaded' });
  await page.getByRole('dialog').waitFor();

  async function setState(name, theme = 'light') {
    await page.evaluate(([state, mode]) => window.__setUpdateState(state, mode), [name, theme]);
    await page.getByRole('dialog').waitFor();
    await page.waitForTimeout(80);
  }

  async function capture(name) {
    await page.screenshot({ path: `${output}${name}.png`, animations: 'disabled' });
    const overflow = await page.getByRole('dialog').evaluate(element =>
      element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2);
    assert.equal(overflow, false, `${name} overflows`);
  }

  await capture('available-light');
  await setState('downloading');
  await page.getByText('42%', { exact: true }).waitFor();
  await capture('downloading-light');
  await setState('downloaded');
  await page.getByRole('button', { name: '立即重启并更新' }).waitFor();
  await capture('downloaded-light');
  await setState('error');
  await page.getByRole('button', { name: '重新检查' }).waitFor();
  await capture('error-dark');

  await setState('available', 'dark');
  await capture('available-dark');
  await setState('checking', 'dark');
  await capture('checking-dark');

  await page.setViewportSize({ width: 390, height: 720 });
  await setState('downloaded', 'dark');
  await capture('downloaded-narrow-dark');
  const bounds = await page.getByRole('dialog').boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, JSON.stringify(bounds));
  assert.deepEqual(errors, []);
  console.log('PASS: updater available, checking, progress, ready, error, light/dark/narrow.');
} finally {
  await browser.close();
}
