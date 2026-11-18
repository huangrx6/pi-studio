/** Exercise the Windows renderer on any host using a synthetic Studio profile. Run after pnpm run build. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa', 'windows-ui');
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(root);
let browser;
try {
  browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: 'chrome' });
  for (const [width, height, scale] of [[1280, 800, 1.25], [980, 640, 1.5]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    page.setDefaultTimeout(10_000);
    const errors = [];
    const report = 'D:\\Studio\\周报.md';
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript({ content: `(${installPerformanceFixture})({ sessionCount: 2, turnCount: 2 });
      window.piApi.platform = 'win32';
      window.piApi.menuBarSettings = async () => ({ platform: 'win32', available: true, enabled: true });
      window.piApi.setMenuBarVisible = async enabled => ({ platform: 'win32', available: true, enabled });
      const readPage = window.piApi.conversationPage;
      window.piApi.conversationPage = async input => {
        const result = await readPage(input);
        result.messages.at(-1).content = [{ type: 'text', text: ${JSON.stringify('`' + report + '`')} }];
        return result;
      };
      window.piApi.fileActions = async () => ({ apps: [] });
      window.piApi.revealFile = async input => { window.revealed = input; return { ok: true }; };
    ` });
    await page.goto(server.origin);
    await page.locator('.session-row').filter({ hasText: '性能会话 0000' }).click();
    await page.locator('.assistant-response').first().waitFor();
    assert.equal(await page.locator('html').getAttribute('data-platform'), 'win32');
    const frame = page.locator('.app');
    assert.equal(await frame.evaluate(node => getComputedStyle(node).borderRadius), '0px');
    assert.ok(await frame.locator('.shell-canvas').first().evaluate(node => parseFloat(getComputedStyle(node).borderRadius) > 0));
    assert.ok(await page.locator('.brand-name').isVisible());
    const padding = locator => locator.evaluate(node => getComputedStyle(node).paddingLeft);
    assert.equal(await padding(page.locator('.brand')), '12px');
    assert.match(await page.getByRole('button', { name: '更多会话动作' }).getAttribute('title'), /Ctrl\+K/);
    await page.getByRole('link', { name: report }).click({ button: 'right' });
    await page.getByText('在文件资源管理器中显示', { exact: true }).click();
    assert.equal(await page.evaluate(() => window.revealed.path), report);
    assert.deepEqual(await page.locator('.app').evaluate(node => {
      node.classList.add('has-custom-background');
      const style = getComputedStyle(node);
      const geometry = [style.marginTop, style.marginBottom, style.borderRadius];
      node.classList.remove('has-custom-background');
      return geometry;
    }), ['18px', '18px', '0px']);
    await page.locator('.sidebar-top-toggle').click();
    await page.locator('.chat-header .sidebar-expand').waitFor();
    assert.equal(await padding(page.locator('.chat-header')), '24px');
    await page.locator('.chat-header .sidebar-expand').click();
    await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
    await page.locator('.panel-start').getByRole('button', { name: '临时聊天', exact: true }).click();
    await page.getByRole('button', { name: '全屏', exact: true }).click();
    assert.equal(await padding(page.locator('.file-panel.is-fullscreen .panel-tabbar')), '10px');
    await page.getByRole('button', { name: '退出全屏', exact: true }).click();

    await page.keyboard.press('Control+,');
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    const tray = settings.getByRole('switch', { name: '隐藏系统托盘图标' });
    await tray.click();
    assert.equal(await settings.getByRole('switch', { name: '显示系统托盘图标' }).getAttribute('aria-checked'), 'false');
    assert.equal(await settings.getByRole('switch', { name: 'Shell 集成' }).count(), 0);
    await settings.getByRole('button', { name: '收起侧边栏' }).click();
    assert.equal(await padding(settings.locator('.settings-header')), '24px');
    await settings.getByRole('button', { name: '展开侧边栏' }).click();
    await page.screenshot({ path: path.join(output, `settings-${width}.png`), animations: 'disabled' });
    await settings.getByRole('button', { name: '返回对话' }).click();
    await page.screenshot({ path: path.join(output, `workbench-${width}.png`), animations: 'disabled' });
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`Windows renderer OK · ${width}×${height} @ ${scale}x`);
  }
} finally {
  await browser?.close();
  await server.close();
}
