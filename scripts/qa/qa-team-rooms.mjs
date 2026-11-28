/** Production renderer and real team SQLite functions. Room data lives in a disposable Studio profile. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import team from '../../electron/main/core/team-project.cjs';
import studio from '../../electron/main/core/studio-db.cjs';
import { installConversationFixture } from './fixtures/conversation-refinement.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa/screenshots/team-rooms');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(root, '.qa/team-rooms-profile-'));
process.env.PI_STUDIO_USER_DATA = profile;
process.env.PI_STUDIO_DB = path.join(profile, 'studio.sqlite');

function installTeamBridge() {
  window.piApi.teamProject = cwd => window.qaTeamProject(cwd);
  window.piApi.teamCreateBot = name => window.qaTeamCreateBot(name);
  window.piApi.teamCreateRoom = (cwd, name) => window.qaTeamCreateRoom(cwd, name);
  window.piApi.teamSetRoomBots = (cwd, roomId, botIds) => window.qaTeamSetRoomBots(cwd, roomId, botIds);
  window.piApi.runtimeServices = async () => ({
    scannedAt: Date.now(), supported: true, services: [], summary: { total: 0, related: 0, agent: 0, workspace: 0, other: 0 },
  });
}

const checks = [], errors = [];
let server, browser, page;
const nav = name => page.getByRole('navigation', { name, exact: true });
const button = (name, container = page) => container.getByRole('button', { name, exact: true });
const heading = name => page.getByRole('heading', { name, exact: true });
const dialog = name => page.getByRole('dialog', { name, exact: true });
const openProject = name => nav('项目工作区列表').getByRole('button', { name: new RegExp(name) }).click();
const openTeam = async () => {
  await button('更多', nav('主导航')).click();
  await button('团队', nav('主导航')).click();
};
const members = () => page.getByRole('list', { name: '群聊成员' }).getByRole('listitem').allTextContents();

async function createRoom(name) {
  await button('新建群聊').press('Enter');
  const editor = dialog('新建群聊');
  await editor.getByRole('textbox', { name: '群聊名称' }).fill(name);
  await button('创建', editor).press('Enter');
  await editor.waitFor({ state: 'detached' });
  await heading(name).waitFor();
}

async function capture(theme, width, height) {
  await page.setViewportSize({ width, height });
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  const geometry = await page.locator('.team-room-browser').evaluate(node => {
    const list = node.querySelector('nav').getBoundingClientRect();
    const chat = node.querySelector('section').getBoundingClientRect();
    return {
      stacked: Math.abs(list.left - chat.left) < 2 && chat.top >= list.bottom - 2,
      contentOverflow: node.scrollWidth - node.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  assert.equal(geometry.contentOverflow, 0);
  assert.equal(geometry.pageOverflow, 0);
  assert.equal(geometry.stacked, width < 1000);
  await page.mouse.move(1, 1);
  const file = `rooms-${theme}-${width}.png`;
  await page.screenshot({ path: path.join(output, file), animations: 'disabled' });
  checks.push({ theme, width, height, ...geometry, file });
}

try {
  studio.getStudioDatabase().upsertWorkspace({ cwd: '/qa/workspaces/alpha', name: 'Alpha 项目' });
  studio.getStudioDatabase().upsertWorkspace({ cwd: '/qa/workspaces/beta', name: 'Beta 文档' });
  team.teamCreateBot('文档编辑');
  server = await serveProductionRenderer(root);
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12000);
  await page.route('**/*', route => new URL(route.request().url()).origin === server.origin
    ? route.continue() : route.abort());
  page.on('pageerror', error => errors.push(String(error)));
  await page.exposeBinding('qaTeamProject', (_, cwd) => team.teamProject(cwd));
  await page.exposeBinding('qaTeamCreateBot', (_, name) => team.teamCreateBot(name));
  await page.exposeBinding('qaTeamCreateRoom', (_, cwd, name) => team.teamCreateRoom(cwd, name));
  await page.exposeBinding('qaTeamSetRoomBots', (_, cwd, roomId, botIds) => team.teamSetRoomBots(cwd, roomId, botIds));
  await page.addInitScript({ content: `(${installConversationFixture})();(${installTeamBridge})();` });
  await page.goto(server.origin);
  await openTeam();
  await button('Bot 成员', nav('团队菜单')).click();
  await button('新建 Bot').click();
  const botEditor = dialog('新建 Bot');
  await botEditor.getByRole('textbox', { name: 'Bot 名称' }).fill('测试工程师');
  await button('创建', botEditor).click();
  await botEditor.waitFor({ state: 'detached' });

  await button('工作区', nav('团队菜单')).click();
  await openProject('Alpha 项目');
  await heading('暂无群聊').waitFor();
  await createRoom('发布讨论');
  await page.getByText('尚未添加 Bot 成员。', { exact: true }).waitFor();
  await button('管理成员').click();
  const memberEditor = dialog('管理群聊成员');
  await memberEditor.getByRole('checkbox', { name: '文档编辑' }).check();
  await memberEditor.getByRole('checkbox', { name: '测试工程师' }).check();
  await button('保存成员', memberEditor).click();
  await memberEditor.waitFor({ state: 'detached' });
  assert.deepEqual(await members(), ['文档编辑', '测试工程师']);
  await createRoom('需求评审');
  await page.getByText('尚未添加 Bot 成员。', { exact: true }).waitFor();
  await button('发布讨论', nav('项目群聊列表')).press('Enter');
  await heading('发布讨论').waitFor();
  await page.getByText('群聊消息功能尚未开放。', { exact: true }).waitFor();
  assert.equal(await button('发布讨论', nav('项目群聊列表')).getAttribute('aria-current'), 'true');
  await heading('发布讨论').click();
  await capture('dark', 1440, 900);
  await capture('light', 760, 680);

  await button('Alpha 项目', nav('团队工作区路径')).click();
  await heading('选择一个群聊').waitFor();
  await button('工作区', nav('团队工作区路径')).click();
  await openProject('Beta 文档');
  await heading('暂无群聊').waitFor();
  await createRoom('周会');
  await button('管理成员').click();
  assert.equal(await memberEditor.getByRole('checkbox').count(), 2);
  await button('取消', memberEditor).click();
  await memberEditor.waitFor({ state: 'detached' });
  assert.equal(await button('发布讨论', nav('项目群聊列表')).count(), 0);

  // Reload the renderer after closing SQLite, so both the view and the storage
  // connection must reconstruct the previous rooms and membership from disk.
  studio.closeStudioDatabase();
  await page.reload();
  await openTeam();
  await button('工作区', nav('团队菜单')).click();
  await openProject('Alpha 项目');
  await heading('选择一个群聊').waitFor();
  assert.deepEqual(await nav('项目群聊列表').getByRole('button').allTextContents(), ['发布讨论', '需求评审']);
  await button('发布讨论', nav('项目群聊列表')).click();
  await heading('发布讨论').waitFor();
  assert.deepEqual(await members(), ['文档编辑', '测试工程师']);
  assert.deepEqual(errors, []);
  await rm(path.join(output, 'failure.png'), { force: true });
  checks.push('real SQLite reopen and renderer reload retained scoped rooms and shared Bot membership');
} catch (error) {
  errors.push(String(error.stack || error));
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
  await browser?.close();
  await server?.close();
  studio.closeStudioDatabase();
  await rm(profile, { recursive: true, force: true });
}
console.log(JSON.stringify({ checks, output }, null, 2));
