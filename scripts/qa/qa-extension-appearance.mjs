import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

const root = new URL('../../', import.meta.url);
const output = new URL('.qa/extension-appearance/', root);
const quota = JSON.parse(await readFile(new URL('extensions/pi-quota-status/pi-studio.extension.json', root), 'utf8'));
function installAppearanceFixture(quotaManifest) {
  const api = window.piApi;
  const detail = { id: 'detail', title: '构建详情', slot: 'conversation.detail', content: [] };
  const build = { id: 'build', title: '构建状态', slots: ['status.chip', 'conversation.footer'], details: 'detail',
    icon: 'terminal', color: 'warning', content: [{ kind: 'text', text: '就绪' }] };
  const cache = { id: 'cache', title: '缓存', slot: 'status.bar', icon: 'database', color: 'info', content: [] };
  const manifests = [quotaManifest, { id: 'qa.build', name: '构建监控', version: '1.0.0', contributes: { panels: [detail, build, cache] } }];
  const extensions = manifests.map(manifest => ({ id: 'user:' + manifest.id, name: manifest.name, version: manifest.version,
    scope: 'user', tier: 'user', enabled: true, trusted: true, available: true, health: 'ready', manifest }));
  const items = extensions.flatMap(extension => extension.manifest.contributes.panels.map(panel => ({
    ...panel, id: extension.id + '/' + panel.id, contributionId: panel.id, extensionId: extension.id, extensionName: extension.name,
    scope: 'user', slot: panel.slot ?? panel.slots[0], slots: panel.slots ?? [panel.slot], size: panel.size ?? 'compact', priority: 0,
  })));
  api.settings = async () => ({ providers: [{ id: 'qa', name: '测试来源', enabled: true, quotaEnabled: true }], extensions, extensionErrors: [], customModels: [], skills: [], mcp: [] });
  api.officialExtensions = async () => ({ extensions: [], errors: [] });
  api.extensionPublisherTrust = async () => ({ publishers: [] });
  api.extensionsUi = async () => ({ items, errors: [], apiVersion: 1, syncedAt: 1 });
  api.providerQuota = async () => ({ status: 'ready', metrics: [], updatedAt: 1 });
}

await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(fileURLToPath(root));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1000, height: 780 } });
  page.setDefaultTimeout(6500);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.request().url().startsWith(server.origin) ? route.continue() : route.abort());
  await page.addInitScript({ content: `const saved = localStorage.getItem('pi-studio:preferences');
    (${installPerformanceFixture})({sessionCount:1,turnCount:1});
    if (saved) localStorage.setItem('pi-studio:preferences', saved);
    (${installAppearanceFixture})(${JSON.stringify(quota)});` });
  const button = name => page.getByRole('button', { name, exact: true });
  const openSettings = async () => {
    await page.locator('.sidebar-bottom button[title="设置"]').click();
    await page.locator('.settings-navigation').getByRole('button', { name: '扩展', exact: true }).click();
  };
  const closeSettings = () => page.locator('.settings-navigation').getByRole('button', { name: '返回对话' }).click();
  const icon = (parent, name, color) => parent.locator(`svg[data-icon="${name}"][data-color="${color}"]`);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('pi-studio:preferences')));
  const buildTrigger = button('构建状态 图标与配色');
  const preview = page.getByRole('group', { name: '构建状态 外观' }).locator('.extension-appearance-preview');
  const menuRow = page.locator('.workspace-menu-extension-row').filter({ hasText: '构建状态' });
  const footer = page.locator('.conversation-extension-dock-item[aria-label="构建状态"]');
  await page.goto(server.origin);
  await page.locator('.session-row').first().click();
  await openSettings();
  await icon(button('额度状态 图标与配色'), 'gauge', 'neutral').waitFor();
  await icon(buildTrigger, 'terminal', 'warning').waitFor();
  await buildTrigger.press('Enter');
  await button('云').click();
  await button('成功绿').click();
  const green = icon(preview, 'cloud', 'success');
  await green.waitFor();
  const lightColor = await green.evaluate(el => getComputedStyle(el).color);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  assert.notEqual(await green.evaluate(el => getComputedStyle(el).color), lightColor);
  const swatches = await page.locator('.extension-color-choices i').evaluateAll(elements => elements.map(el => getComputedStyle(el).backgroundColor));
  assert.equal(new Set(swatches).size, 6, 'settings preview retains the six workspace colors');
  await page.getByRole('article', { name: '构建监控' }).screenshot({ path: fileURLToPath(new URL('settings-dark.png', output)) });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.getByRole('article', { name: '构建监控' }).screenshot({ path: fileURLToPath(new URL('settings-light.png', output)) });
  await icon(button('缓存 图标与配色'), 'database', 'info').waitFor();
  await button('额度状态 图标与配色').click();
  await page.getByRole('group', { name: '额度状态 外观' }).getByRole('button', { name: '钱包' }).click();
  await closeSettings();
  await icon(footer, 'cloud', 'success').waitFor();
  await button('打开扩展与轨迹').click();
  await icon(menuRow, 'cloud', 'success').waitFor();
  assert.equal(await icon(menuRow, 'cloud', 'success').evaluate(el => getComputedStyle(el).color), lightColor);
  await icon(page.locator('.quota-menu-row'), 'wallet', 'neutral').click();
  await icon(page.locator('.provider-quota-dialog'), 'wallet', 'neutral').waitFor();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('.session-row').first().click();
  await icon(footer, 'cloud', 'success').waitFor();
  await openSettings();
  await page.getByRole('group', { name: '构建状态 显示位置' }).getByRole('button', { name: '顶栏' }).click();
  await buildTrigger.click();
  await preview.getByRole('button', { name: '恢复默认' }).click();
  await icon(preview, 'terminal', 'warning').waitFor();
  const prefs = await stored();
  assert.equal(prefs.extensionPlacements['user:qa.build/build'], 'chip');
  assert.deepEqual(prefs.extensionAppearances, { 'user:pi-quota-status/quota-chip': { icon: 'wallet' } });
  await closeSettings();
  await button('打开扩展与轨迹').click();
  await icon(menuRow, 'terminal', 'warning').waitFor();
  assert.equal(await footer.count(), 0);
  assert.deepEqual(errors, []);
  console.log('Verified per-panel appearance in settings, quota, extension status and footer across themes and reload.');
} finally {
  await browser?.close();
  await server.close();
}
