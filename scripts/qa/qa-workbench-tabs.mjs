import { openSessionInspection } from './fixtures/open-session-inspection.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { prepareAtlasWorkspace } from './fixtures/atlas-workspace.mjs';
import { startChecklistModel } from './fixtures/checklist-model.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureTestModel, launchTestDesktop, selectTestSession } from './fixtures/isolated-desktop.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, '.qa', 'worktree-tabs');
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-worktree-tabs-')));
const cwd = path.join(directory, 'workspace');
const feature = path.join(directory, 'feature');
const model = await startChecklistModel();
const profile = path.join(directory, 'profile');
const searchFiles = ['search-index.ts', 'search-options.ts', 'index-manifest.ts', 'query-parser.ts',
  'query-planner.ts', 'result-ranking.ts', 'search-cache.ts', 'search-history.ts'];
let app, page;
const errors = [];
async function launch() {
  ({ app, page } = await launchTestDesktop(cwd, profile, 1440, 920));
  page.on('pageerror', (error) => errors.push(error.message));
}
const tab = (name) => page.getByRole('tab', { name, exact: true });
const button = (name) => page.getByRole('button', { name, exact: true });
const file = (name) => page.locator('.file-row').filter({ hasText: name });
const editor = () => page.locator('.session-document .monaco-editor');
const waitForReadingPosition = () => page.waitForFunction(() => {
  const firstLine = document.querySelector('.session-document .monaco-editor .view-line')?.textContent;
  return Number(/line\s+(\d+)/.exec(firstLine || '')?.[1]) > 3;
});
try {
  await Promise.all([prepareAtlasWorkspace(cwd, feature), mkdir(profile), mkdir(output, { recursive: true })]);
  const missing = path.join(directory, 'old-checkout');
  execFileSync('git', ['-C', cwd, 'worktree', 'add', '-q', '-b', 'qa/offline', missing]);
  await rename(missing, path.join(directory, 'moved-checkout'));
  await writeFile(
    path.join(cwd, 'notes.txt'),
    Array.from({ length: 400 }, (_, i) => 'line ' + (i + 1)).join('\n'),
  );
  await writeFile(path.join(cwd, 'other.txt'), 'another file');
  await Promise.all(searchFiles.map(name => writeFile(path.join(cwd, name), 'export const enabled = true;\n')));
  await launch();
  await page.locator('.main.is-new-conversation').waitFor();
  assert.equal(await page.getByRole('tablist', { name: '工作树标签' }).count(), 0);
  await configureTestModel(page, cwd, model.baseUrl);
  const [a, b, c] = await page.evaluate(async ({cwd, feature}) => {
    const a = await window.piApi.createConversation({ cwd, title: '会话 A' });
    const b = await window.piApi.createConversation({ cwd, title: '会话 B' });
    const c = await window.piApi.createConversation({ cwd: feature, title: '功能分支对话' });
    return [a.id, b.id, c.id];
  }, {cwd, feature});
  await page.reload();
  await selectTestSession(page, cwd, a);
  const toggle = page.locator('.content-region > button.workspace-panel-toggle');
  await toggle.waitFor();
  const control = await toggle.elementHandle();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await button('打开右侧面板').click();
  await page.locator('#workspace-side-panel').waitFor();
  await file('notes.txt').dblclick();
  await tab('notes.txt').waitFor();
  assert.ok(await control.evaluate(node => node.isConnected), 'the document tab keeps the same sidebar control');
  await button('收起右侧面板').click();
  await page.locator('#workspace-side-panel').waitFor({ state: 'hidden' });
  assert.equal(await tab('notes.txt').getAttribute('aria-selected'), 'true');
  await toggle.click();
  await page.locator('#workspace-side-panel').waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await editor().click();
  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  await waitForReadingPosition();
  await page.waitForFunction(
    async cwd => (await window.piApi.readLayout('worktree:' + JSON.stringify([cwd, 'branch', 'main']), 'center'))?.tabs.find(t => t.path === 'notes.txt')?.scroll >= 360,
    cwd,
  );
  const search = () => page.getByRole('searchbox',{name:'搜索工作区文件'});
  await button('内容').click();
  await search().fill('line 289');
  await page.locator('.explorer-hit mark').filter({hasText:'line 289'}).waitFor();
  const title = page.locator('.explorer-match-group .explorer-basename');
  assert.ok(await title.evaluate(node => node.clientHeight >= parseFloat(getComputedStyle(node).fontSize)));
  await selectTestSession(page, cwd, b);
  await tab('会话 B').waitFor();
  assert.equal(await tab('会话 B').getAttribute('aria-selected'), 'true');
  assert.equal(await tab('会话 A').count(), 1);
  assert.equal(await tab('notes.txt').count(), 1);
  assert.equal(await search().inputValue(), 'line 289');
  await tab('notes.txt').click();
  const footer = () => page.getByRole('contentinfo', { name: '状态栏' });
  await footer().getByRole('button', { name: '切换分支，当前 main' }).click();
  const occupied = page.getByRole('button', { name: /feat\/tag-search 已占用/ });
  await occupied.waitFor();
  assert.ok(await occupied.isDisabled());
  assert.equal(await occupied.locator('.lucide-branch').count(), 1);
  assert.equal(await footer().getByRole('button', { name: '切换分支，当前 main' }).locator('.lucide-branch').count(), 1);
  await page.getByRole('dialog', { name: '切换分支' }).screenshot({ path: path.join(output, 'branch-menu.png') });
  await page.keyboard.press('Escape');
  const mainTreePicker = () => footer().getByRole('button', { name: '切换工作树，当前 主工作树' });
  assert.equal(await mainTreePicker().locator('.lucide-primary-worktree').count(), 1);
  const treeButton = await mainTreePicker().boundingBox();
  const dotSlot = await mainTreePicker().locator('svg').boundingBox();
  assert.ok(Math.abs((dotSlot.x + dotSlot.width / 2) - (treeButton.x + treeButton.width / 2)) < .1,
    'the worktree dot is centered horizontally in its status bar button');
  const branchButton = await button('切换分支，当前 main').boundingBox();
  assert.ok(branchButton.x + branchButton.width <= treeButton.x && await mainTreePicker().innerText() === '');
  await mainTreePicker().focus();
  await page.keyboard.press('ArrowUp');
  const treeMenu = () => page.getByRole('dialog', { name: '切换工作树' });
  const linkedOption = treeMenu().getByRole('button', { name: /feat\/tag-search · feature/ });
  await linkedOption.waitFor();
  assert.equal(await treeMenu().getByRole('button', { name: /主工作树/ }).locator('.lucide-primary-worktree').count(), 1);
  assert.equal(await linkedOption.locator('.lucide-folders').count(), 1);
  assert.ok(await treeMenu().getByRole('button', { name: /old-checkout.*登记失效/ }).isDisabled());
  const popup = await treeMenu().boundingBox(), trigger = await mainTreePicker().boundingBox();
  assert.ok(popup.y >= 0 && popup.y + popup.height <= trigger.y);
  assert.ok(await treeMenu().evaluate(menu => {
    const split = document.querySelector('.sidebar-resize-handle').getBoundingClientRect();
    const rect = menu.getBoundingClientRect();
    return menu.contains(document.elementFromPoint(split.left + split.width / 2, rect.top + rect.height / 2));
  }), 'the worktree picker receives pointer events across the sidebar divider');
  await page.screenshot({ path: path.join(output, 'worktree-picker.png'), scale: 'css' });
  await treeMenu().getByRole('textbox').fill('feat/tag-search');
  assert.equal(await treeMenu().getByRole('button', { name: /主工作树/ }).count(), 0);
  await page.keyboard.press('ArrowDown');
  assert.ok(await linkedOption.evaluate(el => el === document.activeElement));
  await page.keyboard.press('Enter');
  await button('切换分支，当前 feat/tag-search').waitFor();
  await selectTestSession(page, feature, c);
  assert.equal(execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'main');
  assert.equal(await tab('notes.txt').count(), 0);
  assert.equal(await tab('会话 A').count(), 0);
  await page.locator('[data-workspace-cwd=' + JSON.stringify(cwd) + '] .workspace-label').click();
  await editor().waitFor();
  assert.equal(await tab('notes.txt').getAttribute('aria-selected'), 'true');
  await selectTestSession(page, cwd, a);
  await tab('notes.txt').click();
  await waitForReadingPosition();
  await openSessionInspection(page);
  await page.getByRole('tab', { name: '进展' }).waitFor();
  await button('关闭会话详情').click();
  await tab('notes.txt').click();
  await page.locator('.explorer-match-group .explorer-basename').filter({ hasText: 'notes.txt' }).waitFor();
  await page.waitForFunction(
    async (id) => (await window.piApi.readLayout('studio', 'navigation'))?.sessionId === id,
    a,
  );
  await page.screenshot({ path: path.join(output, 'center-files.png') });
  await app.close();
  await launch();
  await tab('会话 A').waitFor();
  assert.equal(await search().inputValue(),'line 289');
  await page.locator('.explorer-hit mark').filter({hasText:'line 289'}).waitFor();
  assert.equal(await tab('notes.txt').getAttribute('aria-selected'), 'true');
  await waitForReadingPosition();
  // Switching the checked-out branch in the same directory also swaps the strip.
  execFileSync('git', ['-C', cwd, 'switch', '-c', 'qa/alternate']);
  await tab('notes.txt').waitFor({state:'hidden', timeout:25000});
  await button('切换分支，当前 qa/alternate').click();
  await page.getByRole('dialog', { name: '切换分支' }).getByRole('button', { name: 'main', exact: true }).click();
  await tab('notes.txt').waitFor();
  assert.equal(await tab('notes.txt').getAttribute('aria-selected'), 'true');
  const send = async (name, tag) => {
    await tab(name).click();
    await page.getByRole('tab', { name, exact: true, selected: true }).waitFor();
    await page.getByRole('textbox', {name:'发送给 Pi 的消息'}).fill(tag);
    await button('发送消息').click();
    await model.wait(tag);
  };
  await send('会话 A', 'QA-SWITCH');
  await send('会话 B', 'QA-DONE');
  await page.waitForFunction(() => document.querySelectorAll('.conversation-tab-running').length === 2);
  await button('切换分支，当前 main').waitFor();
  await page.screenshot({path:path.join(output, 'concurrent-conversations.png')});
  await button('关闭 会话 A').click();
  await tab('会话 A').waitFor({state:'hidden'});
  await model.reply('QA-SWITCH','finish','A 的后台回合已完成');
  await model.reply('QA-DONE','finish','B 的回合已完成');
  await page.locator('.chat-scroll').getByText('B 的回合已完成', {exact:true}).waitFor();
  await selectTestSession(page, cwd, a);
  await page.locator('.chat-scroll').getByText('A 的后台回合已完成', {exact:true}).waitFor();
  assert.equal(await tab('notes.txt').count(), 1);
  assert.equal(await tab('会话 B').count(), 1);
  await button('关闭 会话 A').click();
  await page.waitForFunction(id => document.querySelector('.session-row.is-active')?.closest('[data-session-id]')?.dataset.sessionId === id, b);
  await tab('会话 B').click();
  await page.locator('.chat-scroll').getByText('B 的回合已完成', {exact:true}).waitFor();
  await mainTreePicker().click();
  await treeMenu().getByRole('button', { name: '管理工作树…' }).click();
  const manage = page.getByRole('dialog', { name: '管理工作树', exact: true });
  const primaryRef = manage.locator('.worktree-ref-label:has(.lucide-primary-worktree)');
  await primaryRef.waitFor();
  assert.equal(await primaryRef.evaluate(label => getComputedStyle(label).alignItems), 'baseline');
  const staleActions = manage.getByRole('button', { name: '更多工作树操作 ' + missing, exact: true });
  await staleActions.click();
  await page.getByRole('menuitem', { name: '检查失效登记…' }).click();
  const unlink = page.getByRole('dialog', { name: '解除失效登记？' });
  await unlink.getByRole('button', { name: '解除登记', exact: true }).click();
  await staleActions.waitFor({ state: 'detached' });
  const released = execFileSync('git', ['-C', cwd, 'for-each-ref', '--format=%(refname:short)|%(worktreepath)', 'refs/heads/qa/offline'], { encoding: 'utf8' });
  assert.equal(released.trim(), 'qa/offline|');
  await manage.getByRole('button', { name: '创建工作树' }).click();
  const create = page.getByRole('dialog', { name: '创建工作树', exact: true });
  await create.getByRole('textbox', { name: '新分支名称' }).fill('qa/review');
  assert.equal(await create.getByRole('textbox', { name: '工作树名称' }).inputValue(), 'workspace-qa-review');
  await create.getByRole('button', { name: '创建工作树', exact: true }).click();
  await create.waitFor({state:'hidden'});
  await manage.getByRole('button', { name: '关闭', exact: true }).click();
  const reviewPath = path.join(directory, 'workspace-qa-review');
  const review = page.locator('[data-workspace-cwd=' + JSON.stringify(reviewPath) + ']');
  assert.equal(await review.locator('.workspace-name').innerText(), 'qa/review');
  await review.locator('.workspace-tree-icon').hover();
  await review.getByRole('tooltip').filter({ hasText: path.basename(reviewPath) }).waitFor();
  assert.equal(await tab('会话 B').getAttribute('aria-selected'), 'true');
  await review.locator('.workspace-row').click();
  await button('切换工作树，当前 ' + path.basename(reviewPath)).click();
  await treeMenu().getByRole('button', { name: /main · 主工作树/ }).click();
  await tab('会话 B').waitFor();
  assert.equal(await tab('notes.txt').count(), 1);
  assert.equal(execFileSync('git', ['-C', reviewPath, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'qa/review');

  await tab('notes.txt').click();
  await button('在右侧打开').click();
  const rightFile = page.getByRole('tablist', { name: '右侧编辑器标签' }).getByRole('tab', { name: 'notes.txt', selected: true });
  await rightFile.waitFor();
  const strip = page.getByRole('tablist', { name: '工作树标签' });
  const openTabs = strip.getByRole('tab');
  const previousTitles = await openTabs.allTextContents();
  const firstMessage = 'QA-RESTART 首条消息';
  await button('新聊天').click();
  await page.getByRole('textbox', { name: '发送给 Pi 的消息' }).fill(firstMessage);
  assert.deepEqual(await openTabs.allTextContents(), previousTitles);
  assert.equal(await strip.getByRole('tab', { selected: true }).count(), 0);
  assert.equal(await openTabs.first().getAttribute('tabindex'), '0');
  assert.ok(await rightFile.isVisible());
  await strip.getByRole('tab', { name: '会话 B' }).click();
  await page.locator('.chat-scroll').getByText('B 的回合已完成', { exact: true }).waitFor();
  await button('新聊天').click();
  await button('发送消息').click();
  await model.wait('QA-RESTART');
  await page.locator('.chat-scroll').getByText(firstMessage, { exact: true }).waitFor();
  assert.deepEqual((await openTabs.allTextContents()).slice(0, -1), previousTitles);
  assert.equal(await openTabs.last().getAttribute('aria-selected'), 'true');
  assert.ok(await rightFile.isVisible());
  await model.reply('QA-RESTART', 'finish');
  await verifyTabManagement();
  await selectTestSession(page, cwd, b);
  await page.locator('.chat-scroll').getByText('B 的回合已完成', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Passed worktree tabs, restart, split scrolling and bulk close, unsaved edits, concurrent conversations and worktree switching.');
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    console.error('Visible window:', (await page.locator('body').innerText()).slice(0, 1500), errors);
  }
  throw error;
} finally {
  await model.close();
  await app?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}

async function verifyTabManagement() {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const main = page.getByRole('tablist', { name: '工作树标签' });
  const split = page.getByRole('tablist', { name: '右侧编辑器标签' });
  const bar = list => page.locator('.session-tab-bar').filter({ has: list });
  const menu = page.getByRole('menu', { name: '标签页操作' });
  const action = name => menu.getByRole('menuitem', { name, exact: true });
  const tabIn = (list, name) => list.getByRole('tab', { name, exact: true });
  const toggle = page.locator('.content-region > button.workspace-panel-toggle');
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await button('名称').click();
  await page.getByRole('searchbox', { name: '搜索工作区文件' }).fill('');
  for (const name of searchFiles) await page.getByRole('treeitem', { name, exact: true }).dblclick();

  async function checkScrolling(list) {
    const strip = bar(list);
    const left = strip.getByTitle('向左滚动标签页'), right = strip.getByTitle('向右滚动标签页');
    const selected = await list.getByRole('tab', { selected: true }).textContent();
    await right.and(page.locator(':disabled')).waitFor();
    await list.hover();
    await page.mouse.wheel(0, -4000);
    await left.and(page.locator(':disabled')).waitFor();
    await right.click();
    await left.and(page.locator(':enabled')).waitFor();
    await list.hover();
    await page.mouse.wheel(4000, 0);
    await right.and(page.locator(':disabled')).waitFor();
    assert.equal(await list.getByRole('tab', { selected: true }).textContent(), selected);
  }
  await checkScrolling(main);
  await tabIn(main, 'result-ranking.ts').click({ button: 'middle' });
  await tabIn(main, 'result-ranking.ts').waitFor({ state: 'detached' });
  assert.equal(await tabIn(main, 'search-history.ts').getAttribute('aria-selected'), 'true');
  await tabIn(main, '会话 B').press('Shift+F10');
  await action('查看会话详情').waitFor();
  await page.keyboard.press('Escape');
  await toggle.click();
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await tabIn(main, 'query-parser.ts').click();
  await bar(main).getByRole('button', { name: '标签页操作' }).click();
  await menu.waitFor();
  const header = await main.locator('xpath=ancestor::header[1]').boundingBox(), popup = await menu.boundingBox();
  await page.screenshot({ path: path.join(output, 'content-tab-actions.png'), scale: 'css',
    clip: { ...header, height: Math.ceil(popup.y + popup.height - header.y + 12) } });
  await page.keyboard.press('Escape');
  await toggle.click();
  await tabIn(main, 'search-history.ts').click();
  await tabIn(main, 'query-parser.ts').click({ button: 'right' });
  await action('在右侧打开').waitFor();
  await action('关闭右侧标签页').click();
  await tabIn(main, 'query-planner.ts').waitFor({ state: 'detached' });
  assert.equal(await tabIn(main, 'query-parser.ts').getAttribute('aria-selected'), 'true');
  for (const name of searchFiles.slice(0, 4)) {
    await tabIn(main, name).click({ button: 'right' });
    await action('在右侧打开').click();
    await tabIn(split, name).waitFor();
  }
  await checkScrolling(split);
  const mainTitles = await main.getByRole('tab').allTextContents();
  await tabIn(split, searchFiles[0]).press('Shift+F10');
  await action('关闭其他标签页').click();
  assert.deepEqual(await split.getByRole('tab').allTextContents(), [searchFiles[0]]);
  assert.deepEqual(await main.getByRole('tab').allTextContents(), mainTitles);

  const editor = page.locator('.content-region > .session-document');
  for (const name of searchFiles.slice(0, 3)) {
    await tabIn(main, name).click();
    await editor.getByRole('button', { name: '编辑文件', exact: true }).click();
    await editor.getByRole('textbox', { name: /源码编辑器/ }).focus();
    await page.keyboard.insertText('// pending edit\n');
    await tabIn(main, name).getByLabel('未保存').waitFor();
  }
  await page.evaluate(() => {
    window.tabClosePrompts = [];
    window.confirm = message => {
      window.tabClosePrompts.push(message);
      return window.tabClosePrompts.length % 2 === 0;
    };
  });
  const closeAll = async () => {
    await bar(main).getByRole('button', { name: '标签页操作' }).press('ArrowDown');
    await action('关闭全部标签页').click();
  };
  await closeAll();
  assert.deepEqual(await main.getByRole('tab').allTextContents(), mainTitles);
  assert.equal(await main.locator('.document-dirty').count(), 3);
  const prompts = await page.evaluate(() => window.tabClosePrompts);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes(searchFiles[1]) && prompts[0].includes(searchFiles[2]) && !prompts[0].includes(searchFiles[0]));
  await closeAll();
  await main.waitFor({ state: 'detached' });
  const shared = tabIn(split, searchFiles[0]);
  await shared.getByLabel('未保存').waitFor();
  await shared.click({ button: 'middle' });
  assert.ok((await page.evaluate(() => window.tabClosePrompts[2])).includes(searchFiles[0]));
  await shared.click({ button: 'middle' });
  await split.waitFor({ state: 'detached' });
}
