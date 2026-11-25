/** Verify workspace removal through the real sidebar and an isolated Studio database. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchTestDesktop } from './fixtures/isolated-desktop.mjs';

const output = fileURLToPath(new URL('../../.qa/workspace-removal/', import.meta.url));
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'profile-'));
const target = path.join(profile, 'remove-me');
const other = path.join(profile, 'keep-me');
await mkdir(target);
await mkdir(other);
const file = path.join(target, 'project.txt');
await writeFile(file, 'project contents');

const { app, page } = await launchTestDesktop(other, profile, 1180, 800);
const workspace = (cwd) => page.locator(`[data-workspace-cwd="${cwd}"]`);
const picker = page.getByRole('button', { name: '新对话工作区', exact: true });
try {
  await page.evaluate(() => window.piApi.waitForStartup());
  const root = fileURLToPath(new URL('../..', import.meta.url));
  await app.evaluate((_electron, { root, target, other }) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const db = require(`${root}/electron/main/core/studio-db.cjs`).getStudioDatabase();
    db.upsertWorkspace({ cwd: target });
    db.upsertWorkspace({ cwd: other });
  }, { root, target, other });
  await page.reload();
  await workspace(target).locator('.workspace-row').click();
  assert.equal(await picker.innerText(), 'remove-me');
  await workspace(target).locator('.workspace-row-shell').hover();
  await workspace(target).getByRole('button', { name: 'remove-me的更多操作' }).click();
  await page.getByRole('menuitem', { name: '永久删除工作区', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '永久删除这个工作区？' });
  await confirmation.getByText('这个工作区没有会话。', { exact: false }).waitFor();
  await app.evaluate(({ ipcMain }, root) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const { listWorkspaces } = require(`${root}/electron/main/runtime/conversations.cjs`);
    const { DEFAULT_CWD, modelInfo } = require(`${root}/electron/main/services/models.cjs`);
    const refresh = new Promise((resolve) => { globalThis.releaseWorkspaceQaRead = resolve; });
    ipcMain.removeHandler('pi:state');
    ipcMain.handle('pi:state', async (_event, cwd) => {
      await refresh;
      return { workspaces: await listWorkspaces(), model: await modelInfo(cwd || DEFAULT_CWD), cwd: DEFAULT_CWD };
    });
  }, root);
  await confirmation.getByRole('button', { name: '永久删除', exact: true }).click();
  await page.waitForFunction(async (cwd) => (await window.piApi.conversationList()).every((item) => item.cwd !== cwd), target);
  const saved = await page.evaluate(async () => (await window.piApi.conversationList()).map(({ cwd }) => cwd));
  assert.deepEqual(saved, [other]);
  assert.equal(await readFile(file, 'utf8'), 'project contents');
  await workspace(target).waitFor({ state: 'detached', timeout: 3000 });
  await confirmation.waitFor({ state: 'hidden' });
  assert.equal(await workspace(other).count(), 1);
  assert.equal(await picker.innerText(), '选择工作区');
  await picker.click();
  const options = page.getByRole('listbox', { name: '新对话工作区' });
  await options.getByRole('option', { name: /keep-me/ }).waitFor();
  assert.equal(await options.getByRole('option', { name: /remove-me/ }).count(), 0);
  await app.evaluate(() => globalThis.releaseWorkspaceQaRead());
  await page.reload();
  await workspace(other).waitFor();
  assert.equal(await workspace(target).count(), 0);
  await app.evaluate(({ dialog }, cwd) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
  }, target);
  await page.getByRole('button', { name: '打开工作区', exact: true }).click();
  await workspace(target).waitFor();
  console.log('Workspace disappears while refresh is pending, stays removed on reload, and returns when explicitly reopened.');
} finally {
  await app.close();
}
