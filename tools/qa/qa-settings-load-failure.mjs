/**
 * Verify a rejected production settings chunk stays inside its local boundary.
 * Run after `pnpm run build`: node tools/qa/qa-settings-load-failure.mjs
 * Uses a disposable profile/workspace; never changes or removes build assets.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const assetDirectory = path.join(root, 'web-dist', 'assets');
const assets = await readdir(assetDirectory);
const usageChunks = assets.filter((name) => /^UsageSettings-[\w-]+\.js$/.test(name));
assert.equal(usageChunks.length, 1, 'build must contain one deferred UsageSettings JS chunk');
const blockedChunk = usageChunks[0];
const blockedUrl = pathToFileURL(path.join(assetDirectory, blockedChunk)).href;
const profile = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-settings-failure-'));
const workspace = path.join(profile, 'workspace');
const output = path.join(root, '.qa', 'settings-load-failure');
await mkdir(workspace);
await mkdir(output, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Settings failure QA\nDisposable workspace.\n');
const env = {
  ...process.env,
  PI_STUDIO_USER_DATA: profile,
  PI_STUDIO_DB: path.join(profile, 'studio.sqlite'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_STUDIO_DEV;

let app;
let page;
const pageErrors = [];
const results = { passed: false, blockedChunk, blockedRequests: [], checks: [] };
const draft = '保留这份未发送草稿：设置加载失败后仍能继续输入。';

async function assertDraft(composer, label) {
  assert.equal(await composer.inputValue(), draft, label);
  assert.equal(await page.locator('.session-row:not(.empty)').count(), 0, 'QA never submits or creates a conversation');
  results.checks.push(label);
}

try {
  app = await _electron.launch({ args: [root], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.locator('.new-conversation-welcome').waitFor();
  assert.match(page.url(), /^file:/, 'failure injection targets the production renderer');

  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, workspace);
  await page.locator('.new-conversation-welcome').getByRole('button', { name: '选择工作区', exact: true }).click();
  await page.locator('.workspace-choice.has-selection').waitFor();
  // Settings intentionally hides the conversation from the accessibility tree;
  // use the DOM locator to verify its mounted, preserved draft behind the overlay.
  const composer = page.locator('textarea[aria-label="发送给 Pi 的消息"]');
  await composer.fill(draft);

  // Electron WebRequest also sees file: resources. Block exactly one JS asset in
  // this disposable renderer's session; other resources and the built file stay intact.
  await app.evaluate(({ BrowserWindow }, target) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'));
    if (!window) throw new Error('QA renderer window not found');
    globalThis.__settingsLoadFailureQa = { blockedRequests: [] };
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, callback) => {
      const cancel = details.url === target;
      if (cancel) globalThis.__settingsLoadFailureQa.blockedRequests.push(details.url);
      callback({ cancel });
    });
  }, blockedUrl);

  await page.locator('.sidebar-bottom button[title="设置"]').click();
  const navigation = page.locator('.settings-navigation');
  await navigation.getByRole('button', { name: '使用量', exact: true }).click();
  const failure = page.locator('.settings-content .deferred-settings-state[role="alert"]');
  await failure.getByRole('heading', { name: '这个设置页暂时无法打开', exact: true }).waitFor();
  assert.equal(await navigation.isVisible(), true, 'settings navigation survives a chunk failure');
  assert.equal(await composer.count(), 1, 'conversation composer remains mounted behind settings');
  await page.waitForFunction(() => document.activeElement === document.querySelector('.deferred-settings-state h2'));
  await assertDraft(composer, 'draft survives the first chunk failure');
  await page.screenshot({ path: path.join(output, '01-load-failure.png'), animations: 'disabled' });

  results.blockedRequests = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'));
    window.webContents.session.webRequest.onBeforeRequest(null);
    return globalThis.__settingsLoadFailureQa.blockedRequests;
  });
  // Vite may request both a module preload and the import for the same URL.
  assert.ok(results.blockedRequests.length > 0, 'the intended deferred chunk was requested');
  assert.deepEqual([...new Set(results.blockedRequests)], [blockedUrl], 'only the intended deferred chunk was blocked');

  await failure.getByRole('button', { name: '打开通用设置', exact: true }).click();
  await page.locator('.settings-content').getByRole('heading', { name: '通用', exact: true }).waitFor();
  assert.equal(await failure.count(), 0, 'changing pages resets only the failed page boundary');
  await navigation.getByRole('button', { name: '返回对话', exact: true }).click();
  await composer.waitFor({ state: 'visible' });
  await assertDraft(composer, 'draft survives opening general settings and returning');

  // Removing the network failure does not clear React.lazy's cached rejection.
  // Re-entering the failed page must remain recoverable, not blank the app.
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await navigation.getByRole('button', { name: '使用量', exact: true }).click();
  await failure.waitFor();
  await failure.getByRole('button', { name: '返回对话', exact: true }).click();
  await composer.waitFor({ state: 'visible' });
  await assertDraft(composer, 'failure fallback returns directly to the intact draft');

  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await navigation.getByRole('button', { name: '快捷键', exact: true }).click();
  await page.locator('.settings-content').getByRole('heading', { name: '快捷键', exact: true }).waitFor();
  await page.locator('.shortcut-list').waitFor();
  assert.equal(await failure.count(), 0, 'another deferred page can load after the first page fails');
  assert.equal(await page.locator('.shortcut-row').count() > 0, true, 'the other page rendered its real controls');
  await page.screenshot({ path: path.join(output, '02-other-lazy-page.png'), animations: 'disabled' });
  await navigation.getByRole('button', { name: '返回对话', exact: true }).click();
  await composer.waitFor({ state: 'visible' });
  await assertDraft(composer, 'draft survives navigating to another deferred page');

  // Chromium/React may report the intentionally rejected import as a page error.
  // Any unrelated renderer error still fails this QA.
  assert.deepEqual(pageErrors.filter((message) => !message.includes(blockedChunk)), [], 'no unrelated renderer errors');
  results.passed = true;
  console.log(`Settings load failure QA passed; output: ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ ...results, pageErrors }, null, 2));
  try {
    if (app) await app.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}
