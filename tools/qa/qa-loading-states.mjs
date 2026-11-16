import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import metrics from '../../electron/capabilities/metrics/index.cjs';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

const root = new URL('../../', import.meta.url);
const output = new URL('.qa/loading-states/', root);
await mkdir(output, { recursive: true });
const scripts = JSON.parse(await readFile(new URL('extensions/pi-project-scripts/pi-studio.extension.json', root), 'utf8'));
const items = [[scripts, 'user'], [metrics.manifests[0], 'builtin']].flatMap(([manifest, scope]) =>
  manifest.contributes.panels.map((panel, sourceOrder) => ({
    ...panel, id: `${scope}:${manifest.id}/${panel.id}`, contributionId: panel.id,
    extensionId: manifest.id, extensionName: manifest.name, scope, sourceOrder,
    slot: panel.slot ?? panel.slots[0], slots: panel.slots ?? [panel.slot],
  })),
);

function holdDataViews(items) {
  const pending = new Map();
  window.piApi.extensionsUi = async () => ({ items, errors: [], syncedAt: Date.now(), apiVersion: 1 });
  window.piApi.openExtensionDataView = ({ sourceId }) => new Promise(resolve => {
    pending.set(sourceId, content => resolve({
      subscriptionId: sourceId, snapshot: { sourceId, revision: 1, updatedAt: Date.now(), content },
    }));
  });
  window.finishDataView = (id, content) => pending.get(id)(content);
}

const server = await serveProductionRenderer(fileURLToPath(root));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  for (const [theme, width] of [['light', 980], ['dark', 1440]]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(server.origin) ? route.continue() : route.abort());
    await page.addInitScript({ content: `(${installPerformanceFixture})({sessionCount:1,turnCount:2});(${holdDataViews})(${JSON.stringify(items)});` });
    await page.goto(server.origin);
    await page.locator('.session-row').first().click();
    await page.locator('.assistant-response').first().waitFor();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const trigger = page.getByRole('button', { name: '打开扩展与轨迹' });
    const menu = page.getByRole('dialog', { name: '扩展与轨迹' });
    const row = menu.locator('.workspace-menu-extension-row').filter({ hasText: '实时指标' });
    const scriptsRow = menu.locator('.workspace-menu-extension-row').filter({ hasText: '项目脚本' });
    const status = row.getByRole('status');
    const height = locator => locator.evaluate(el => el.getBoundingClientRect().height);
    await trigger.click();
    await scriptsRow.getByText('正在读取项目脚本').waitFor();
    await status.getByText('正在连接实时数据').waitFor();
    await status.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    assert.ok(await height(status) <= 20, 'default compact loading fits one text line');
    const pendingHeight = await height(row);
    assert.ok(Math.abs(pendingHeight - await height(scriptsRow)) <= 1, 'default and extension-authored hints have the same row height');
    const icon = status.locator('svg[aria-hidden="true"]');
    assert.equal(await icon.evaluate(el => getComputedStyle(el).color), await status.evaluate(el => getComputedStyle(el).color));
    await menu.screenshot({ path: fileURLToPath(new URL(`menu-${theme}.png`, output)), animations: 'disabled' });

    await page.evaluate(() => {
      document.documentElement.style.setProperty('--loading-icon-size', '14px');
      document.documentElement.style.setProperty('--loading-spin-duration', '2s');
    });
    assert.deepEqual(await icon.evaluate(el => [getComputedStyle(el).width, getComputedStyle(el).animationDuration]), ['14px', '2s']);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await icon.evaluate(el => getComputedStyle(el).animationName), 'none');
    assert.equal(await status.evaluate(el => getComputedStyle(el).opacity), '1');
    for (const [content, expected] of [[[{ kind: 'text', text: '32 tok/s' }], '32 tok/s'], [[], '空闲']]) {
      await page.evaluate(({ id, content }) => window.finishDataView(id, content), { id: metrics.METRICS_FOOTER_SOURCE_ID, content });
      await row.getByText(expected, { exact: true }).waitFor();
      assert.ok(Math.abs(pendingHeight - await height(row)) <= 1, 'populated and empty rows retain their loading height');
      assert.equal(await status.count(), 0);
      if (content.length) {
        await trigger.click();
        // Stretch the threshold so the next result arrives deterministically before any visible loading frame.
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(() => document.documentElement.style.setProperty('--loading-delay', '60s'));
        await trigger.click();
        await status.waitFor();
        assert.equal(await status.evaluate(el => getComputedStyle(el).opacity), '0');
      }
    }
    assert.deepEqual(errors, []);
    console.log(`${theme} · ${width}px · menu row ${pendingHeight}px`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
