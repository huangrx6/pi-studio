import { replaceSourceText, visibleSourceText } from './fixtures/source-editor.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchTestDesktop, configureTestModel, selectTestSession } from './fixtures/isolated-desktop.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa/git-workflow');
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-git-workflow-')));
const repo = path.join(temporary, 'studio-themes');
const remote = path.join(temporary, 'origin.git');
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const bottom = locator => locator.evaluate(node => node.getBoundingClientRect().bottom);
const bottomBorder = locator => locator.evaluate(node => getComputedStyle(node).borderBlockEndWidth);
await mkdir(output, { recursive: true });
const profile = path.join(temporary, 'studio');
let app, page;
try {
  git(temporary, 'init', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'Pi Studio'); git(repo, 'config', 'user.email', 'qa@studio.invalid');
  const original = [
    ':root {', '  --panel-bg: #ffffff;', '  --panel-border: #e4e6e9;', '}',
    '', '.panel {', '  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    '  color: gray;', '  background: var(--panel-bg);', '  padding: 12px;', '}',
    '', '.panel-header {', '  display: flex;', '  align-items: center;', '  gap: 6px;', '}',
  ].join('\n') + '\n';
  await writeFile(path.join(repo, 'palette.css'), original);
  git(repo, 'add', '.'); git(repo, 'commit', '-m', '建立面板配色');
  git(repo, 'switch', '-c', 'design/typography');
  await writeFile(path.join(repo, 'type.css'), 'body { line-height: 1.6; }\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', '调整正文行高');
  git(repo, 'switch', 'main'); git(repo, 'merge', '--no-ff', '-m', '合并排版调整', 'design/typography');
  git(temporary, 'init', '-b', 'main', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote);
  await writeFile(path.join(repo, 'palette.css'), original.replace('color: gray;', 'color: teal;').replace('padding: 12px;', 'padding: 16px;').replace('gap: 6px;', 'gap: 8px;'));
  await writeFile(path.join(repo, 'type.css'), 'body { line-height: 1.7; }\n');
  await mkdir(path.join(repo, 'themes'));
  await writeFile(path.join(repo, 'themes', 'contrast.css'), ':root { color-scheme: light dark; }\n');
  git(repo, 'add', 'themes/contrast.css');
  await mkdir(profile);
  ({ app, page } = await launchTestDesktop(repo, profile, 1280, 860));
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.locator('.sidebar-bottom button[aria-label="设置"]').waitFor();
  await page.evaluate(() => {
    const key = 'pi-studio:preferences';
    const current = JSON.parse(localStorage.getItem(key) || '{}');
    localStorage.setItem(key, JSON.stringify({ ...current, showCodeView: true }));
  });
  await page.reload();
  // This workflow never sends a model request.
  await configureTestModel(page, repo, 'http://127.0.0.1:1/v1');
  const notes = path.join(temporary, 'notes');
  await mkdir(notes);
  await page.evaluate(cwd => window.piApi.createConversation({ cwd, title: '非 Git 工作区' }).then(() => undefined), notes);
  const id = await page.evaluate(async cwd => (await window.piApi.createConversation({ cwd, title: 'Git 工作流验收' })).id, repo);
  await selectTestSession(page, repo, id);
  const button = name => page.getByRole('button', { name, exact: true });
  async function openSessionGit(branch) {
    const picker = button('切换分支，当前 ' + branch);
    await picker.waitFor();
    await selectTestSession(page, repo, id);
    await picker.click();
    await button('打开 Git').click();
    await page.locator('.file-panel .git-workspace-page').waitFor();
  }
  const capture = name => page.screenshot({ path: path.join(output, name + '.png'), scale: 'css', animations: 'disabled' });
  const composer = page.locator('.composer-editor');
  await composer.fill('保留会话草稿');
  await button('切换分支，当前 main').click();
  await page.getByRole('dialog', { name: '切换分支' }).getByText('design/typography', { exact: true }).waitFor();
  assert.deepEqual(await page.getByLabel('搜索或创建分支').evaluate(el => {
    const style = getComputedStyle(el);
    return [style.boxShadow, style.borderTopWidth];
  }), ['none', '0px']);
  await capture('branches');
  await page.getByLabel('搜索或创建分支').fill('design/tokens');
  await button('创建并切换到 design/tokens').click();
  await openSessionGit('design/tokens');
  assert.ok(await composer.isVisible());
  const commitCard = page.locator('.git-index');
  const chatCard = page.locator('.composer:visible');
  assert.equal(await bottom(commitCard), await bottom(chatCard), 'the commit card and chat composer share a bottom edge');
  await capture('changes-chat');
  const work = page.getByRole('region', { name: '工作区', exact: true });
  const staged = page.getByRole('region', { name: '暂存区', exact: true });
  const preview = page.getByRole('region', { name: '文件差异 palette.css' });
  const diffTab = page.getByRole('tabpanel', { name: 'palette.css' });
  await work.getByRole('button', { name: 'palette.css 修改', exact: true }).click();
  await preview.locator('.diff-code').first().waitFor();
  assert.ok(await diffTab.isVisible());
  assert.equal(await page.locator('.file-panel .git-file-diff').count(), 0);
  assert.deepEqual(await preview.evaluate(node => {
    const style = getComputedStyle(node);
    return [style.borderWidth, style.borderRadius];
  }), ['0px', '0px'], 'the Git diff shares the document canvas without a second frame');
  const columns = preview.locator('.diff-columns');
  await columns.waitFor();
  assert.equal(await bottomBorder(columns), '1px');
  const endOfDiff = await bottom(columns);
  assert.ok(endOfDiff < await bottom(preview.locator('.diff-view-body')), 'A short diff ends above the blank canvas');
  const panes = columns.locator('.diff-pane');
  assert.equal(await panes.count(), 2);
  assert.ok(await panes.evaluateAll((nodes, end) => nodes.every(pane =>
    pane.scrollWidth > pane.clientWidth && Math.abs(pane.getBoundingClientRect().bottom + 1 - end) < 1
  ), endOfDiff), 'Both horizontal scrollbars meet the same bottom border');
  await capture('changes');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await capture('changes-dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await preview.getByRole('button', { name: '文件预览' }).click();
  const previewBody = preview.locator('.file-preview-body');
  await previewBody.locator('.view-line').first().waitFor();
  assert.equal(await bottom(previewBody), await bottom(diffTab), 'the file version fills the available document height');
  await previewBody.locator('.view-line').filter({ hasText: 'teal' }).waitFor();
  await preview.getByRole('button', { name: '查看差异' }).click();
  const longBranch = 'feature/20261109-conversation-mode-and-workspace-layout-improvements';
  git(repo, 'switch', '-c', longBranch);
  await button('刷新 Git').click();
  await openSessionGit(longBranch);
  await work.getByRole('button', { name: 'palette.css 修改', exact: true }).click();
  const commitForm = page.locator('.git-commit-form');
  await commitForm.getByText(longBranch, { exact: true }).waitFor();
  async function verifyCommitControls(screenshot) {
    const input = commitForm.getByLabel('提交说明');
    await input.fill('验证长分支提交');
    const submit = commitForm.getByRole('button', { name: '提交暂存的修改' });
    await submit.scrollIntoViewIfNeeded();
    assert.ok(await commitForm.evaluate(form => {
      const caption = form.querySelector('.git-commit-target');
      const bounds = form.getBoundingClientRect();
      return caption.getBoundingClientRect().right <= bounds.right && [form.querySelector('textarea'), form.querySelector('button')].every(control => {
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.right - 4, rect.top + rect.height / 2);
        return rect.left >= bounds.left && rect.right <= bounds.right && control.contains(hit);
      });
    }), 'the long branch truncates and the full input and button stay within the commit pane');
    await submit.click({ trial: true });
    if (screenshot) await capture(screenshot);
    await input.fill('');
  }
  await verifyCommitControls();
  const layoutToggle = preview.getByRole('button', { name: /^切换为/ });
  const oldMode = await layoutToggle.getAttribute('aria-label');
  await layoutToggle.click();
  assert.notEqual(await layoutToggle.getAttribute('aria-label'), oldMode);
  await capture('changes-narrow');
  // Match the reported working-tree size with real untracked files; scroll and open the last one.
  await page.locator('.git-view-toolbar nav').getByRole('button', { name: '提交历史' }).click();
  const bulk = path.join(repo, 'zz-load'), bulkCount = 43321;
  await mkdir(bulk);
  for (let first = 0; first < bulkCount; first += 500) {
    const chunk = path.join(bulk, String(first).padStart(5, '0'));
    await mkdir(chunk);
    for (let j = first; j < Math.min(first + 500, bulkCount); j += 100) {
      await Promise.all(Array.from({ length: Math.min(100, bulkCount - j, first + 500 - j) }, (_, k) =>
        writeFile(path.join(chunk, (j + k) + '.txt'), j + k === bulkCount - 1 ? 'last file\n' : '')));
    }
  }
  const opened = Date.now();
  await page.locator('.git-view-toolbar nav').getByRole('button', { name: '变更' }).click();
  await work.locator('h3 small').filter({ hasText: /^43323$/ }).waitFor();
  const openMs = Date.now() - opened;
  const renderedRows = await work.locator('.git-file-row').count();
  assert.ok(renderedRows > 0 && renderedRows < 64, String(renderedRows));
  await verifyCommitControls('changes-long-branch');
  const summary = await page.evaluate(cwd => window.piApi.gitWorkspaceStatus(cwd), repo);
  assert.equal(summary.statusReadFailed, false);
  assert.equal(summary.dirty.total, bulkCount + 3);
  await work.locator('.git-file-name').first().focus();
  await page.keyboard.press('End');
  const lastPath = 'zz-load/43000/43320.txt';
  await work.getByRole('button', { name: lastPath + ' 未跟踪', exact: true }).click();
  await page.locator('.git-file-diff .diff-code').filter({ hasText: 'last file' }).first().waitFor();
  await capture('changes-large');
  await rm(bulk, { recursive: true });
  git(repo, 'switch', 'design/tokens');
  await button('刷新 Git').click();
  await openSessionGit('design/tokens');
  await work.getByText('2', { exact: true }).waitFor();
  await button('暂存 palette.css').click();
  await button('取消暂存 palette.css').waitFor();
  await staged.getByRole('button', { name: 'palette.css 修改', exact: true }).click();
  await preview.locator('.diff-code').first().waitFor();
  await button('取消暂存 palette.css').click();
  await button('暂存 palette.css').waitFor();
  await work.getByRole('button', { name: 'palette.css 修改', exact: true }).click();
  await button('全部暂存').click();
  await page.getByLabel('提交说明').fill('更新面板配色');
  await button('提交暂存的修改').click();
  await page.getByText('已提交', { exact: true }).waitFor();
  await page.getByRole('heading', { name: '工作区干净' }).waitFor();
  await button('远程同步').click();
  await button('获取 Fetch').waitFor();
  assert.ok(await page.locator('.git-remote-picker .pi-select-value').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  const syncBounds = await page.locator('.git-view-toolbar, .git-remote, .git-remote-refs, .git-remote-operations').evaluateAll(nodes => nodes.map(el => {
    const { left, right } = el.getBoundingClientRect(); return { left, right };
  }));
  assert.equal(syncBounds.length, 4);
  assert.ok(syncBounds.every(box => Math.abs(box.left - syncBounds[0].left) < 1 && Math.abs(box.right - syncBounds[0].right) < 1), JSON.stringify(syncBounds));
  assert.ok(Math.abs((await button('获取 Fetch').boundingBox()).x + (await button('获取 Fetch').boundingBox()).width - syncBounds[0].right) < 1);
  await capture('sync-first-push');
  await button('管理远程仓库').click();
  const manager = page.getByRole('dialog', { name: '管理远程 · origin' });
  await manager.getByText(remote, { exact: true }).waitFor();
  assert.equal(await manager.getByLabel('新的获取地址').inputValue(), remote);
  await manager.getByRole('button', { name: '远程操作' }).click();
  await page.getByRole('option', { name: '添加远程' }).click();
  await manager.getByLabel('远程名称').fill('backup');
  await manager.getByLabel('仓库地址').fill(remote);
  await manager.getByRole('button', { name: '添加远程', exact: true }).click();
  await page.locator('.git-remote-picker').getByText('backup', { exact: true }).waitFor();
  await button('管理远程仓库').click();
  const backup = page.getByRole('dialog', { name: '管理远程 · backup' });
  await backup.getByRole('button', { name: '远程操作' }).click();
  await page.getByRole('option', { name: '移除远程' }).click();
  await backup.getByRole('button', { name: '确认移除' }).click();
  await page.locator('.git-remote-picker').getByText('origin', { exact: true }).waitFor();
  const mirror = path.join(temporary, 'mirror.git');
  git(temporary, 'init', '--bare', mirror);
  for (const address of [remote, mirror]) git(repo, 'config', '--add', 'remote.origin.pushurl', address);
  await button('刷新 Git').click();
  await page.locator('.git-remote-addresses dd').filter({ hasText: mirror }).waitFor();
  await button('推送 Push').click();
  const push = page.getByRole('dialog', { name: '推送预览' });
  assert.ok(await push.getByRole('button', { name: '确认推送' }).isDisabled());
  await push.getByRole('button', { name: '推送目标地址' }).click();
  await page.getByRole('option', { name: mirror, exact: true }).click();
  await push.locator('.git-sync-address').filter({ hasText: mirror }).waitFor();
  await push.getByText('更新面板配色', { exact: true }).waitFor();
  await push.getByRole('button', { name: '取消' }).click();
  assert.equal(git(mirror, 'for-each-ref', 'refs/heads'), '');
  git(repo, 'config', '--unset-all', 'remote.origin.pushurl');
  await button('刷新 Git').click();
  await page.locator('.git-remote-addresses dd').filter({ hasText: mirror }).waitFor({ state: 'hidden' });
  await button('获取 Fetch').click();
  await page.getByText('已获取远程更新', { exact: true }).waitFor();
  await button('推送 Push').click();
  await push.getByText('更新面板配色', { exact: true }).waitFor();
  await capture('push-preview');
  await push.getByRole('button', { name: '取消' }).click();
  assert.equal(git(remote, 'for-each-ref', 'refs/heads/design/tokens'), '');
  await button('推送 Push').click();
  await push.getByRole('button', { name: '确认推送' }).click();
  await page.getByText('推送完成', { exact: true }).waitFor();
  const hash = git(remote, 'rev-parse', 'refs/heads/design/tokens');
  assert.equal(hash, git(repo, 'rev-parse', 'HEAD'));
  const peer = path.join(temporary, 'peer');
  git(temporary, 'clone', '-b', 'design/tokens', remote, peer);
  await writeFile(path.join(peer, 'spacing.css'), '.panel { gap: 12px; }\n');
  git(peer, 'add', 'spacing.css');
  git(peer, '-c', 'user.name=Pi QA', '-c', 'user.email=peer@studio.invalid', 'commit', '-m', '补充面板间距');
  git(peer, 'push', 'origin', 'design/tokens');
  const incoming = git(peer, 'rev-parse', 'HEAD');
  await button('获取 Fetch').click();
  await page.getByText('已获取远程更新', { exact: true }).waitFor();
  assert.equal(git(repo, 'rev-parse', 'origin/design/tokens'), incoming);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), hash);
  await page.getByRole('heading', { name: '有 1 个远程提交待拉取' }).waitFor();
  await capture('sync');
  await button('拉取 Pull').click();
  const pull = page.getByRole('dialog', { name: '拉取预览' });
  await pull.getByText('补充面板间距', { exact: true }).waitFor();
  await pull.getByText('origin/design/tokens', { exact: true }).waitFor();
  assert.equal(git(repo, 'rev-parse', 'HEAD'), hash);
  await pull.getByRole('button', { name: '确认拉取' }).click();
  await page.getByText('拉取完成', { exact: true }).waitFor();
  assert.equal(git(repo, 'rev-parse', 'HEAD'), incoming);
  assert.equal(await readFile(path.join(repo, 'spacing.css'), 'utf8'), '.panel { gap: 12px; }\n');
  await writeFile(path.join(repo, 'spacing.css'), '.panel { gap: 14px; }\n');
  git(repo, 'commit', '-am', '本地调整间距');
  await writeFile(path.join(peer, 'spacing.css'), '.panel { gap: 18px; }\n');
  git(peer, '-c', 'user.name=Pi QA', '-c', 'user.email=peer@studio.invalid', 'commit', '-am', '远程调整间距');
  git(peer, 'push', 'origin', 'design/tokens');
  await button('刷新 Git').click();
  await page.getByRole('heading', { name: '有 1 个本地提交待推送' }).waitFor();
  await button('推送 Push').click();
  await push.getByText('远程调整间距', { exact: true }).waitFor();
  assert.ok(await push.getByRole('button', { name: '确认安全强推' }).isDisabled());
  await push.getByRole('checkbox').check();
  assert.ok(await push.getByRole('button', { name: '确认安全强推' }).isEnabled());
  await push.getByRole('button', { name: '取消' }).click();
  assert.equal(git(remote, 'rev-parse', 'refs/heads/design/tokens'), git(peer, 'rev-parse', 'HEAD'));
  await button('拉取 Pull').click();
  await pull.getByRole('button', { name: '确认拉取' }).click();
  await button('查看合并中的文件').click();
  await button('打开冲突文件 spacing.css').click();
  await button('编辑文件').click();
  const sourceEditor = page.getByLabel('spacing.css 源码编辑器');
  assert.match(await visibleSourceText(page.locator('.session-document')), /<<<<<<< HEAD/);
  await replaceSourceText(sourceEditor, '.panel { gap: 15px; }\n');
  await button('保存文件').click();
  await button('编辑文件').waitFor();
  await button('标记为已解决 spacing.css').click();
  await page.getByText('所有冲突已解决，可以提交合并。').waitFor();
  await page.getByLabel('提交说明').fill('合并间距调整');
  await button('提交合并').click();
  await page.getByRole('heading', { name: '工作区干净' }).waitFor();
  assert.equal(git(repo, 'show', '-s', '--format=%P').split(' ').length, 2);
  await button('远程同步').click();
  await button('推送 Push').click();
  await push.getByRole('button', { name: '确认推送' }).click();
  await page.getByText('推送完成', { exact: true }).waitFor();
  await button('提交历史').click();
  assert.equal(await page.getByText('拉取完成', { exact: true }).count(), 0);
  const pageHistory = Array.from({ length: 123 }, (_, i) =>
    'commit refs/heads/qa-pages\ncommitter QA <qa@example.invalid> ' + (1600000000 + i) + ' +0000\ndata ' + ('pagination-' + i).length + '\npagination-' + i + '\n\n').join('');
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: pageHistory });
  await page.getByLabel('搜索提交').fill('pagination-');
  await page.getByText('第 1 / 3 页 · 共 123 次提交').waitFor();
  const pager = page.getByRole('navigation', { name: '提交历史分页' });
  const historyBottom = await bottom(page.locator('.file-panel-inner'));
  assert.equal(await bottom(pager), historyBottom, 'the pager reaches the bottom of the Git panel');
  const historyList = page.locator('.git-history-list');
  assert.ok(await historyList.evaluate(list => {
    list.scrollTop = list.scrollHeight;
    return list.scrollTop > 0;
  }));
  assert.equal(await bottom(pager), historyBottom, 'scrolling commits leaves the pager in place');
  await page.getByLabel('跳转页码').fill('3');
  await button('跳转').click();
  await page.getByText('第 3 / 3 页 · 共 123 次提交').waitFor();
  assert.equal(await page.locator('.git-history-row').count(), 3);
  assert.equal(await bottom(pager), historyBottom, 'short pages keep the same footer position');
  assert.ok(await button('下一页').isDisabled());
  await capture('history-pagination');
  await page.getByLabel('搜索提交').fill('更新面板配色');
  await page.locator('.git-history-row').filter({ hasText: '更新面板配色' }).click();
  await page.getByText(hash, { exact: true }).waitFor();
  await page.locator('.git-history-file').filter({ hasText: 'palette.css' }).click();
  await page.getByRole('tabpanel', { name: 'palette.css' }).waitFor();
  await page.locator('.git-file-diff .diff-code').filter({ hasText: 'teal' }).first().waitFor();
  await capture('detail');
  await page.getByRole('tab', { name: 'Git 工作流验收', exact: true }).click();
  assert.equal(await composer.innerText(), '保留会话草稿');
  await button('返回提交历史').click();
  await page.locator('.git-history-row').first().waitFor();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForFunction(() => {
    const color = getComputedStyle(document.querySelector('.git-history-row strong')).color;
    return Number(color.match(/\d+/)?.[0]) > 160;
  });
  await capture('history-dark');
  assert.equal(await page.locator('.git-workspace-page').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  const typography = locator => locator.evaluate(el => {
    const { fontSize, fontWeight, lineHeight, letterSpacing } = getComputedStyle(el);
    return { fontSize, fontWeight, lineHeight, letterSpacing };
  });
  const gitTabs = page.getByRole('navigation', { name: 'Git 视图' });
  assert.equal(await page.locator('.git-workspace-page').getByRole('heading', { name: '版本控制' }).count(), 0);
  const activeTabText = await typography(gitTabs.locator('[aria-pressed=true]'));
  const historySubject = await typography(page.locator('.git-history-subject strong').first());
  await page.getByRole('tab', { name: 'Git 工作流验收', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '查看会话详情', exact: true }).click();
  await button('关闭会话详情').click();
  await page.locator('.git-workspace-page').waitFor();
  async function openGitSettings() {
    await page.locator('.sidebar-bottom button[aria-label="设置"]').click();
    await page.locator('.settings-navigation').getByRole('button', { name: 'Git', exact: true }).click();
  }
  git(repo, 'worktree', 'add', '-q', path.join(temporary, '排版预览'), 'design/typography');
  const spacingRules = Array.from({ length: 60 }, (_, n) => `.gap-${n} { gap: ${n}px; }`);
  await writeFile(path.join(repo, 'spacing.css'), ['.panel { gap: 16px; }', ...spacingRules, ''].join('\n'));
  await writeFile(path.join(repo, 'review.md'), 'review\n');
  git(repo, 'add', 'review.md');
  await openGitSettings();
  const settings = page.locator('.git-settings');
  const repoStatus = settings.getByRole('region', { name: '仓库状态' });
  await repoStatus.getByText('2 个文件有变更').waitFor();
  assert.equal(await repoStatus.locator('details').getAttribute('open'), null);
  await page.mouse.move(0, 0);
  await capture('settings-overview');
  await repoStatus.locator('summary').click();
  await repoStatus.getByText('已暂存 1 · 未暂存 1 · 未跟踪 0').waitFor();
  const files = settings.getByRole('list', { name: '变更文件' });
  await files.getByText('review.md', { exact: true }).waitFor();
  await files.getByText('spacing.css', { exact: true }).waitFor();
  await settings.getByText('origin/design/tokens · 已对齐').waitFor();
  await repoStatus.locator('summary').click();
  assert.equal(await settings.locator('.git-worktree-row').count(), 2);
  const workspacePicker = settings.getByRole('button', { name: '工作区', exact: true });
  await workspacePicker.click();
  await page.getByRole('option', { name: /^notes/ }).click();
  await settings.getByText('这个工作区没有 Git 仓库。').waitFor();
  assert.equal(await settings.locator('.git-worktree-row').count(), 0);
  await workspacePicker.click();
  await page.getByRole('option', { name: /^studio-themes/ }).click();
  await repoStatus.getByText('2 个文件有变更').waitFor();
  await settings.getByRole('region', { name: '差异显示' }).waitFor();
  await settings.getByRole('button', { name: '左右对照' }).click();
  await settings.getByRole('switch', { name: '长行自动换行' }).click();
  await page.waitForFunction(() => {
    const prefs = JSON.parse(localStorage.getItem('pi-studio:preferences'));
    return prefs.gitDiffLayout === 'split' && prefs.gitDiffWrap;
  });
  await capture('settings-light');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await capture('settings-dark');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 740));
  await page.waitForFunction(() => innerWidth <= 980);
  assert.equal(await settings.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  await capture('settings-narrow');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
  await settings.getByRole('button', { name: '打开 Git 面板' }).click();
  await work.getByRole('button', { name: 'spacing.css 修改', exact: true }).click();
  const wrapped = page.locator('.git-file-diff .diff-view.is-wrapped');
  const pairs = wrapped.locator('.diff-paired');
  await pairs.waitFor();
  assert.equal(await bottomBorder(pairs), '1px');
  const viewport = wrapped.locator('.diff-view-body');
  assert.ok(await bottom(pairs) > await bottom(viewport), 'The closing edge follows the last row below the viewport');
  await viewport.evaluate(node => { node.scrollTop = node.scrollHeight; });
  assert.ok(Math.abs(await bottom(pairs) - await bottom(viewport)) < 1);
  await wrapped.getByRole('button', { name: '切换为单列差异' }).click();
  await wrapped.locator('.diff-unified').waitFor();
  assert.equal(await bottomBorder(wrapped.locator('.diff-unified')), '1px');
  await page.locator('.git-view-toolbar nav').getByRole('button', { name: '提交历史', exact: true }).click();
  await page.locator('.git-history-row').first().click();
  await page.locator('.git-history-file').first().click();
  await wrapped.locator('.diff-paired').waitFor();
  await openGitSettings();
  const create = page.getByRole('dialog', { name: '创建工作树', exact: true });
  const remove = page.getByRole('dialog', { name: '移除工作树？' });
  const settingsToast = page.locator('.settings-toast-stack .settings-toast');
  const modalToast = create.locator('.settings-toast-layer:popover-open .settings-toast');
  const createGeometry = () => create.evaluate(dialog => ({
    height: dialog.getBoundingClientRect().height,
    scrollHeight: dialog.querySelector('.dialog-body').scrollHeight,
    scrollTop: dialog.querySelector('.dialog-body').scrollTop,
  }));
  await settings.getByRole('button', { name: '创建工作树' }).click();
  await create.getByRole('button', { name: '已有分支' }).click();
  await create.getByRole('button', { name: '本地分支' }).click();
  await create.getByRole('option', { name: 'main', exact: true }).click();
  const folderName = create.getByRole('textbox', { name: '工作树名称', exact: true });
  assert.equal(await folderName.inputValue(), path.basename(repo) + '-main');
  assert.ok((await folderName.getAttribute('aria-describedby')).length > 0);
  await folderName.fill(path.basename(repo));
  const beforeError = await createGeometry();
  await folderName.press('Enter');
  await modalToast.filter({ hasText: '目标文件夹已存在' }).waitFor();
  assert.equal(await modalToast.getAttribute('role'), 'alert');
  assert.equal(await modalToast.evaluate(node => getComputedStyle(node.closest('[popover]')).position), 'fixed');
  assert.deepEqual(await createGeometry(), beforeError, 'failed create toast leaves dialog height and scroll unchanged');
  await folderName.fill('main-review');
  await create.getByRole('button', { name: '新建分支', exact: true }).click();
  await create.getByRole('textbox', { name: '新分支名称' }).fill('qa/experiment');
  assert.equal(await folderName.inputValue(), 'main-review', 'a custom directory name survives branch edits');
  await create.getByRole('button', { name: '已有分支', exact: true }).click();
  const treeParent = path.join(temporary, 'worktrees');
  await mkdir(treeParent);
  await app.evaluate(({ dialog }, parent) => {
    const native = dialog.showOpenDialog;
    dialog.showOpenDialog = async options => {
      if (options.title !== '选择新工作树的父目录') throw new Error('Unexpected directory picker');
      dialog.showOpenDialog = native;
      return { canceled: false, filePaths: [parent] };
    };
  }, treeParent);
  await create.getByRole('button', { name: '选择父目录' }).click();
  const existingTree = path.join(treeParent, 'main-review');
  await create.getByText(existingTree, { exact: true }).waitFor();
  await capture('worktree-create');
  await create.getByRole('button', { name: '创建工作树', exact: true }).click();
  const treeMenu = settings.getByRole('button', { name: '更多工作树操作 ' + existingTree, exact: true });
  const openRemoval = async () => {
    await treeMenu.click();
    await page.getByRole('menuitem', { name: '移除工作树', exact: true }).click();
  };
  await treeMenu.waitFor();
  await settingsToast.filter({ hasText: '已创建工作树' }).waitFor();
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { value: async text => { window.qaCopiedWorktree = text; } });
  });
  await treeMenu.scrollIntoViewIfNeeded();
  const worktrees = settings.getByRole('region', { name: '工作树', exact: true });
  const worktreeGeometry = () => worktrees.evaluate(card => ({
    height: card.getBoundingClientRect().height,
    scrollTop: card.closest('.settings-content').scrollTop,
    scrollHeight: card.closest('.settings-content').scrollHeight,
  }));
  const beforeCopy = await worktreeGeometry();
  await treeMenu.click();
  await page.getByRole('menuitem', { name: '复制路径', exact: true }).click();
  await settingsToast.filter({ hasText: '已复制工作树路径' }).waitFor();
  assert.equal(await page.evaluate(() => window.qaCopiedWorktree), existingTree);
  assert.deepEqual(await worktreeGeometry(), beforeCopy, 'copy toast leaves worktree height and scroll unchanged');
  await capture('worktree-copy-toast');
  await settingsToast.waitFor({ state: 'detached' });
  assert.deepEqual(await worktreeGeometry(), beforeCopy, 'copy toast dismissal leaves worktree height and scroll unchanged');
  assert.equal(git(existingTree, 'branch', '--show-current'), 'main');
  await writeFile(path.join(existingTree, 'draft.txt'), 'keep this');
  await openRemoval();
  await remove.getByRole('alert').filter({ hasText: '未跟踪 1' }).waitFor();
  await capture('worktree-remove');
  await remove.getByRole('button', { name: '取消' }).click();
  assert.equal(await readFile(path.join(existingTree, 'draft.txt'), 'utf8'), 'keep this');
  // Exercise native IPC and Git, redirect just the OS bin into this disposable profile.
  const bin = path.join(temporary, 'test-bin');
  await app.evaluate(({ shell }, { source, bin }) => {
    shell.trashItem = async target => {
      if (target !== source) throw new Error('Unexpected trash target');
      await process.getBuiltinModule('fs').promises.rename(target, bin);
    };
  }, { source: existingTree, bin });
  await openRemoval();
  await remove.getByRole('button', { name: '移入回收站' }).click();
  await treeMenu.waitFor({ state: 'detached' });
  await settingsToast.filter({ hasText: '已移除工作树' }).waitFor();
  assert.equal(await readFile(path.join(bin, 'draft.txt'), 'utf8'), 'keep this');
  assert.ok(git(repo, 'rev-parse', '--verify', 'refs/heads/main'));
  for (const branch of ['spring', 'summer', 'autumn', 'winter']) {
    git(repo, 'worktree', 'add', '-q', '-b', 'theme/' + branch, path.join(temporary, branch));
  }
  await settings.getByRole('button', { name: '刷新 Git 状态' }).click();
  const treeSearch = settings.getByRole('searchbox', { name: '搜索分支或目录' });
  await treeSearch.waitFor();
  assert.equal(await settings.locator('.git-worktree-row').count(), 5);
  await settings.getByRole('button', { name: '下一页工作树' }).click();
  assert.equal(await settings.locator('.git-worktree-row').count(), 1);
  await treeSearch.fill('theme/summer');
  await settings.locator('.git-worktree-row').getByText('theme/summer', { exact: true }).waitFor();
  await settings.getByRole('button', { name: '创建工作树' }).click();
  await create.getByRole('textbox', { name: /^新分支名称/ }).fill('feature/worktree');
  await create.getByRole('button', { name: '分支起点' }).click();
  await page.getByRole('option', { name: /^design\/typography/ }).click();
  await create.getByRole('checkbox', { name: '创建后切换到此工作树' }).check();
  await create.screenshot({ path: path.join(output, 'worktree-new-branch.png'), scale: 'css', animations: 'disabled' });
  await create.getByRole('button', { name: '创建工作树', exact: true }).click();
  await settings.waitFor({ state: 'detached' });
  const newTree = path.join(temporary, 'studio-themes-feature-worktree');
  await page.locator('[data-workspace-cwd="' + newTree + '"] .workspace-row.is-active').waitFor();
  assert.equal(git(newTree, 'branch', '--show-current'), 'feature/worktree');
  assert.equal(git(newTree, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'design/typography'));

  // Rooms with the same name can belong to different checkouts of one project.
  const roomTitle = '工作树评审';
  await page.evaluate(async ({ main, linked, title }) => {
    await window.piApi.teamCreateRoom(main, title);
    await window.piApi.teamCreateRoom(linked, title);
  }, { main: repo, linked: newTree, title: roomTitle });
  const leftTree = page.locator('[data-workspace-cwd=' + JSON.stringify(newTree) + ']');
  const branchRow = leftTree.locator('.workspace-row[aria-expanded]');
  await branchRow.waitFor();
  if (await branchRow.getAttribute('aria-expanded') === 'false') await branchRow.click();
  await leftTree.getByRole('button', { name: roomTitle, exact: true }).click();
  await page.locator('.team-room-detail').getByRole('heading', { name: roomTitle }).waitFor();
  const teamSidebar = page.getByRole('navigation', { name: '团队菜单' });
  const teamCheckout = branch => teamSidebar.locator('.workspace').filter({ has: page.getByText(branch, { exact: true }) });
  const linkedRoomTree = teamCheckout('feature/worktree');
  await linkedRoomTree.getByRole('button', { name: roomTitle, exact: true, current: 'page' }).waitFor();
  await writeFile(path.join(newTree, 'room-file.txt'), 'linked checkout review');
  await button('打开右侧面板').click();
  await page.locator('.workspace-side-modes').getByRole('button', { name: 'Git', exact: true }).click();
  await work.getByRole('button', { name: 'room-file.txt 未跟踪', exact: true }).click();
  await page.getByRole('tabpanel', { name: 'room-file.txt' }).getByText(/linked checkout review/).first().waitFor();

  const mainRoomTree = teamCheckout('design/tokens');
  const mainRoomHeader = mainRoomTree.locator('.workspace-row');
  if (await mainRoomHeader.getAttribute('aria-expanded') === 'false') await mainRoomHeader.click();
  await mainRoomTree.getByRole('button', { name: roomTitle, exact: true }).click();
  await mainRoomTree.getByRole('button', { name: roomTitle, exact: true, current: 'page' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'room-file.txt' }).count(), 0);
  await linkedRoomTree.getByRole('button', { name: roomTitle, exact: true }).click();
  await page.getByRole('tabpanel', { name: 'room-file.txt' }).waitFor();
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'results.json'), JSON.stringify({
    branch: 'design/tokens', pushedCommit: hash, pulledCommit: incoming, reviewedFile: 'palette.css', largeWorktree: { files: bulkCount + 2, renderedRows, openMs },
    typography: { activeTabText, historySubject },
  }, null, 2));
  console.log('Git flow verified from branch creation to local remote sync, commit review and preserved chat draft.');
} catch (error) {
  if (page && !page.isClosed()) console.error(await page.evaluate(() => ({
    text: document.body.innerText.slice(0, 2800),
    layout: [...document.querySelectorAll('.git-workspace-page, .git-index, .git-groups, .git-file-group, .git-file-list')].map(el => [el.className, el.clientHeight, el.scrollHeight]),
  })));
  throw error;
} finally {
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
