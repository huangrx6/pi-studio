/** Check the shipping renderer, preload and main process in a disposable desktop profile. */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchTestDesktop, preferenceLayout } from './fixtures/isolated-desktop.mjs';

const output = fileURLToPath(new URL('../../.qa/device-storage/', import.meta.url));
const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-studio-storage-')));
const workspace = path.join(temp, 'workspace');
const profile = path.join(temp, 'profile');
const attachments = path.join(profile, 'data', 'attachments');
let app;
try {
  for (const dir of [output, workspace, profile, attachments]) await mkdir(dir, { recursive: true });
  const desktop = await launchTestDesktop(workspace, profile, 1240, 850);
  app = desktop.app;
  const { page } = desktop;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Exercise the native action handoff without opening Finder/Explorer or replacing the user's clipboard.
  await app.evaluate(({ shell, clipboard }) => {
    globalThis.storageQaActions = [];
    shell.openPath = async target => { globalThis.storageQaActions.push(['open', target]); return ''; };
    clipboard.writeText = target => { globalThis.storageQaActions.push(['copy', target]); };
  });
  await writeFile(path.join(attachments, 'first.bin'), Buffer.alloc(1024));
  for (const [dir, size] of [['extension-data', 2], ['background-media', 3], ['worktrees', 1]]) {
    await mkdir(path.join(profile, 'data', dir), { recursive: true });
    await writeFile(path.join(profile, 'data', dir, 'storage-qa.bin'), Buffer.alloc(size * 1024 ** 2));
  }
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  const nav = page.locator('.settings-navigation');
  const content = page.locator('.settings-content');
  const open = id => nav.locator('[data-settings-page="' + id + '"]').click();
  async function theme(label, value) {
    await open('general');
    await content.getByRole('button', { name: label, exact: true }).click();
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, value);
  }
  const storage = content.locator('.device-storage-settings');
  const management = storage.getByRole('region', { name: '数据管理' });
  const archiveButton = management.getByRole('button', { name: '查看归档会话' });
  const worktreesButton = management.getByRole('button', { name: '管理工作树' });
  const folderButton = storage.locator('.storage-locations').getByRole('button', { name: /中显示|显示文件位置/ }).first();
  async function checkManagementButtons() {
    const [folder, archive, worktrees] = await Promise.all([folderButton, archiveButton, worktreesButton].map(button =>
      button.evaluate(el => {
        const { width, height, right } = el.getBoundingClientRect();
        const { fontSize, fontWeight, color, border, borderRadius } = getComputedStyle(el);
        return { width, shared: { height, right, fontSize, fontWeight, color, border, borderRadius } };
      })));
    assert.deepEqual(archive, worktrees);
    assert.deepEqual(archive.shared, folder.shared);
  }
  const attachmentSize = storage.locator('.storage-legend [data-category=attachments] dd');
  await theme('浅色', 'light');
  const generalLayout = await preferenceLayout(content, { section: '.preference-group-head h2',
    control: '.general-radius-options', description: '.general-setting-description' });
  const search = nav.getByRole('searchbox', { name: '搜索设置' });
  await search.fill('磁盘');
  await open('storage');
  await search.fill('');
  await attachmentSize.filter({ hasText: /^1 KB$/ }).waitFor();
  const storageLayout = await preferenceLayout(storage, { section: '.preference-group-head h2',
    control: '.preference-group-actions button', description: '.preference-group-head p' });
  assert.deepEqual(storageLayout, generalLayout);
  await checkManagementButtons();
  await storage.getByRole('button', { name: /^复制完整路径 · 应用/ }).click();
  await folderButton.click();
  const actions = await app.evaluate(() => globalThis.storageQaActions);
  assert.deepEqual(actions, [['copy', profile], ['open', profile]]);
  await writeFile(path.join(attachments, 'second.bin'), Buffer.alloc(2048));
  await storage.getByRole('button', { name: '刷新', exact: true }).click();
  await attachmentSize.filter({ hasText: /^3 KB$/ }).waitFor();
  await page.locator('.settings-toast-stack .settings-toast').waitFor({ state: 'hidden' });
  await nav.locator('[data-settings-page="storage"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'light.png'), animations: 'disabled' });
  await archiveButton.click();
  await content.getByRole('heading', { level: 1, name: '归档会话' }).waitFor();
  await open('storage');
  await worktreesButton.click();
  const defaults = page.getByRole('dialog', { name: '共用运行默认值', exact: true });
  await page.waitForFunction(() => document.activeElement?.id === 'subagent-worktrees');
  const heading = await defaults.locator('#subagent-worktrees').boundingBox();
  const body = await defaults.locator('.dialog-body').boundingBox();
  assert.ok(heading && body && heading.y >= body.y && heading.y + heading.height <= body.y + body.height);
  await defaults.getByRole('button', { name: '关闭', exact: true }).click();
  await defaults.waitFor({ state: 'detached' });
  assert.ok(await content.getByRole('button', { name: '共用运行默认值' }).evaluate(node => node === document.activeElement));
  await theme('深色', 'dark');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 730));
  await open('storage');
  await attachmentSize.filter({ hasText: /^3 KB$/ }).waitFor();
  await page.locator('.settings-toast-stack .settings-toast').waitFor({ state: 'hidden' });
  assert.ok(await storage.evaluate(el => el.scrollWidth <= el.clientWidth));
  await checkManagementButtons();
  await page.screenshot({ path: path.join(output, 'dark-narrow.png'), animations: 'disabled' });
  await management.screenshot({ path: path.join(output, 'management-dark.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('Device storage: search, measured bytes, refresh, native location actions, both management links and two theme layouts passed.');
} finally {
  try { await app?.close(); } finally { await rm(temp, { recursive: true, force: true }); }
}
