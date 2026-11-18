import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioDatabase } from '../../electron/main/core/studio-db.cjs';
import { configureTestModel, launchTestDesktop, selectTestSession } from './fixtures/isolated-desktop.mjs';

const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-usage-projects-')));
const profile = path.join(temporary, 'profile');
const active = path.join(temporary, '编辑器');
const removed = path.join(temporary, '配色实验');
const output = fileURLToPath(new URL('../../.qa/usage-projects/', import.meta.url));
let app;
try {
  await Promise.all([active, removed, profile, output].map(dir => mkdir(dir, { recursive: true })));
  const desktop = await launchTestDesktop(active, profile, 1200, 780);
  app = desktop.app;
  const { page } = desktop;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await configureTestModel(page, active, 'http://127.0.0.1:1/v1');
  const create = cwd => page.evaluate(async cwd => (await window.piApi.createConversation({ cwd })).id, cwd);
  const activeId = await create(active);
  const removedId = await create(removed);
  const db = createStudioDatabase(path.join(profile, 'studio.sqlite'));
  try {
    for (const [index, [conversationId, input, cost]] of [[activeId, 1200, 1.25], [removedId, 2400, 2.5], ['', 300, 0.25]].entries()) {
      db.recordUsageRequest({ requestId: 'usage-qa-' + index, conversationId, input, cost, providerId: 'desktop-qa', modelId: 'check' });
    }
  } finally { db.close(); }
  await page.evaluate(id => window.piApi.conversationAction({ action: 'remove', kind: 'workspace', id }), removed);
  await selectTestSession(page, active, activeId);
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  const nav = page.locator('.settings-navigation');
  await nav.getByRole('button', { name: '使用量', exact: true }).click();
  const filter = page.getByRole('button', { name: '按项目筛选使用量' });
  const include = page.getByRole('checkbox', { name: '包括已移除项目' });
  const select = async label => {
    await filter.click();
    await page.getByRole('option').filter({ has: page.getByText(label, { exact: true }) }).click();
  };
  const verify = async (cost, tokens, requests) => {
    await page.locator('.usage-stat dd').filter({ hasText: cost }).waitFor();
    await page.locator('.usage-models-meta').getByText(`1 个模型 · ${tokens} tokens · ${requests} 次请求`, { exact: true }).waitFor();
    assert.match(await page.locator('.usage-cumulative').innerText(), new RegExp(requests + ' 次请求'));
    assert.ok((await page.locator('.usage-day-detail').innerText()).includes(tokens + ' tokens'));
  };
  await verify('$4.00', '3,900', 3);
  await select('编辑器');
  await verify('$1.25', '1,200', 1);
  await select('未归属用量');
  await verify('$0.25', '300', 1);
  await select('配色实验（已移除）');
  await verify('$2.50', '2,400', 1);
  await filter.click();
  await page.screenshot({ path: path.join(output, 'project-filter.png'), scale: 'css' });
  await page.keyboard.press('Escape');
  await include.uncheck();
  await verify('$1.50', '1,500', 2);
  assert.equal(await filter.innerText(), '全部项目');
  await filter.click();
  assert.equal(await page.getByRole('option', { name: /配色实验/ }).count(), 0);
  await page.keyboard.press('Escape');
  const scroller = page.locator('.settings-content');
  assert.equal(await scroller.evaluate(el => getComputedStyle(el, '::-webkit-scrollbar').width), '0px');
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await scroller.hover();
  await page.mouse.wheel(0, 280);
  await page.waitForFunction(() => document.querySelector('.settings-content').scrollTop > 0);
  await filter.focus();
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await page.keyboard.press('PageDown');
  await page.waitForFunction(() => document.querySelector('.settings-content').scrollTop > 0);
  await nav.getByRole('button', { name: '关于', exact: true }).click();
  const versions = await page.evaluate(cwd => window.piApi.settings(cwd).then(value => value.runtimeVersions), active);
  const environment = page.getByRole('region', { name: '运行环境' });
  for (const key of ['durable', 'electron', 'chromium', 'node', 'sqlite']) {
    assert.match(versions[key], /^\d+\./);
    await environment.getByText(versions[key], { exact: true }).waitFor();
  }
  await page.getByRole('region', { name: '本地存储与诊断信息' }).getByText(path.join(profile, 'studio.sqlite'), { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'runtime.png'), scale: 'css' });
  await page.reload();
  const openSettings = page.locator('.sidebar-bottom button[title="设置"]');
  if (!(await nav.isVisible())) await openSettings.click();
  await nav.getByRole('button', { name: '使用量', exact: true }).click();
  await verify('$1.50', '1,500', 2);
  assert.equal(await include.isChecked(), false);
  await include.check();
  await verify('$4.00', '3,900', 3);
  assert.deepEqual(errors, []);
  console.log('Verified actual workspace removal, project, unattributed and combined usage, persistent visibility, native scrolling and installed runtime versions.');
} finally {
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
