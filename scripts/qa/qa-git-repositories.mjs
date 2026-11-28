import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import archive from '../../electron/main/core/extension-archive.cjs';
import { configureTestModel, launchTestDesktop, selectTestSession } from './fixtures/isolated-desktop.mjs';

const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-git-projects-')));
const workspace = path.join(temp, 'workspace');
const client = path.join(workspace, 'apps/client');
const api = path.join(workspace, 'services/api');
const image = '界面截图.jpg';
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore','pipe','pipe'] });
const output = '.qa/git-repositories';
let app;
try {
  await mkdir(output, { recursive: true });
  for (const [dir, branch] of [[client, 'design'], [api, 'api-main']]) {
    await mkdir(dir, { recursive: true });
    git(dir, 'init', '-b', branch);
    git(dir, 'config', 'user.name', 'Studio QA');
    git(dir, 'config', 'user.email', 'qa@example.invalid');
  }
  const desktop = await launchTestDesktop(workspace, path.join(temp, 'profile'), 1310, 820);
  app = desktop.app;
  const { page } = desktop;
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  const screenshot = await readFile(new URL('../../website/assets/screens/usage-light.png', import.meta.url), 'base64');
  const pictures = await page.evaluate(async source => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + source;
    await img.decode();
    return [480, 540, 640, 720].map(width => {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = Math.round(width * img.naturalHeight / img.naturalWidth);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg').split(',')[1];
    });
  }, screenshot);
  const put = (name, i) => writeFile(path.join(client, name), Buffer.from(pictures[i], 'base64'));
  await put(image, 0); git(client, 'add', '.'); git(client, 'commit', '-m', '初版截图');
  await put(image, 1); git(client, 'add', '.'); git(client, 'commit', '-m', '更新截图');
  await put(image, 2); git(client, 'add', image); await put(image, 3); await put('未跟踪.jpg', 0);
  await writeFile(path.join(api, 'api.txt'), 'service'); git(api, 'add', '.'); git(api, 'commit', '-m', '服务端初版');
  git(api, 'remote', 'add', 'api-origin', path.join(temp, 'local.git'));
  const createOffice = (name, parts) => writeFile(path.join(api, name),
    archive.createZipArchive(Object.entries(parts).map(([path, content]) => ({ path, content }))));
  await createOffice('说明.docx', { 'word/document.xml': '<w:document xmlns:w="urn:word"><w:p><w:r><w:t>发布说明正文</w:t></w:r></w:p></w:document>' });
  await createOffice('清单.xlsx', {
    'xl/workbook.xml': '<workbook xmlns:r="http://type/relationships"><sheets><sheet name="项目" r:id="r1"/><sheet name="费用" r:id="r2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><row r="1"><c r="B1" t="s"><v>0</v></c></row></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><row r="2"><c r="C2"><v>239</v></c></row></worksheet>',
    'xl/sharedStrings.xml': '<sst><si><t>工作表内容</t></si></sst>',
  });
  await createOffice('演示.pptx', { 'ppt/slides/slide1.xml': '<sld><p><t>第一页标题</t></p></sld>', 'ppt/slides/slide2.xml': '<sld><p><t>第二页标题</t></p></sld>' });
  await createOffice('归档.zip', { 'docs/notes.txt': 'sample' });
  await configureTestModel(page, workspace, 'http://127.0.0.1:1/v1');
  const id = await page.evaluate(async cwd => (await window.piApi.createConversation({ cwd, title: '多项目审阅' })).id, workspace);
  await page.evaluate(cwd => window.piApi.conversationAction({ kind: 'workspace', id: cwd, action: 'rename', name: '产品工作区' }), workspace);
  await page.reload();
  await selectTestSession(page, workspace, id);
  const button = name => page.getByRole('button', { name, exact: true });
  const choose = async (label, name) => {
    await button(label).click();
    await page.getByRole('option', { name, exact: true }).click();
  };
  await button('切换分支，当前 design').waitFor();
  await button('切换分支，当前 design').click();
  await button('打开 Git').click();
  await page.locator('.file-panel .git-workspace-page').waitFor();
  assert.ok(await page.locator('.composer-editor').isVisible());
  await page.getByRole('navigation', { name: 'Git 视图' }).waitFor();
  const work = page.getByRole('region', { name: '工作区', exact: true });
  const index = page.getByRole('region', { name: '暂存区', exact: true });
  const checkImage = async width => page.waitForFunction(width => {
    const img = document.querySelector('.git-file-diff .file-preview-media img');
    return img?.naturalWidth === width;
  }, width);
  await work.getByRole('button', { name: '未跟踪.jpg 未跟踪', exact: true }).click();
  await checkImage(480);
  await work.getByRole('button', { name: image + ' 修改', exact: true }).click();
  await checkImage(720);
  await button('暂存版本').click(); await checkImage(640);
  await index.getByRole('button', { name: image + ' 修改', exact: true }).click();
  await checkImage(640); await button('HEAD 版本').click(); await checkImage(540);
  await page.screenshot({ path: path.join(output, 'image-versions.png'), scale: 'css' });
  await page.evaluate(() => {
    const sample = () => {
      const tabs = document.querySelector('.git-view-toolbar nav');
      if (tabs) window.headerPositions.push(tabs.getBoundingClientRect().top);
    };
    window.headerPositions = []; sample();
    new MutationObserver(sample).observe(document.querySelector('.git-workspace-page').parentElement, { childList: true, subtree: true });
  });
  await button('提交历史').click();
  await page.locator('.git-history-row').filter({ hasText: '更新截图' }).click();
  await page.locator('.git-history-file').filter({ hasText: image }).click();
  await checkImage(540);
  await button('父提交版本').click(); await checkImage(480);
  assert.equal(await button('用系统应用打开文件').count(), 0);
  const back = button('返回提交历史');
  assert.ok(await back.evaluate(node => node.title === node.getAttribute('aria-label') && !node.textContent.trim()
    && Math.abs(node.getBoundingClientRect().right - node.parentElement.getBoundingClientRect().right) <= 1));
  await back.click();
  await page.locator('.git-history-row').filter({ hasText: '更新截图' }).click();
  await choose('选择项目仓库', 'services/api');
  await button('切换分支，当前 api-main').waitFor();
  await page.locator('.git-history-row').filter({ hasText: '服务端初版' }).waitFor();
  assert.equal(await page.locator('.git-history-row').filter({ hasText: '更新截图' }).count(), 0);
  await button('远程同步').click();
  await page.getByText('api-origin', { exact: true }).first().waitFor();
  await button('变更').click();
  const selectFile = name => work.getByRole('button', { name: name + ' 未跟踪', exact: true }).click();
  await selectFile('说明.docx'); await page.getByText('发布说明正文', { exact: true }).waitFor();
  await selectFile('清单.xlsx'); await page.getByRole('cell', { name: '工作表内容' }).waitFor();
  await choose('选择工作表', '费用'); await page.getByRole('cell', { name: '239' }).waitFor();
  await selectFile('演示.pptx'); await page.getByText('第一页标题', { exact: true }).waitFor();
  await choose('选择幻灯片', '第 2 页'); await page.getByText('第二页标题', { exact: true }).waitFor();
  await selectFile('归档.zip'); await page.getByText('docs/notes.txt', { exact: true }).waitFor();
  await choose('状态栏项目仓库', 'apps/client');
  await button('切换分支，当前 design').waitFor();
  await button('提交历史').click(); await page.locator('.git-history-row').filter({ hasText: '更新截图' }).waitFor();
  const positions = await page.evaluate(() => window.headerPositions);
  assert.ok(positions.length > 5 && positions.every(top => Math.abs(top - positions[0]) <= 1), JSON.stringify(positions));
  await page.locator('.sidebar-bottom button[aria-label="设置"]').click();
  await page.locator('.settings-navigation').getByRole('button', { name: 'Git', exact: true }).click();
  const settings = page.locator('.git-settings');
  await choose('设置中的项目仓库', 'services/api');
  await settings.getByRole('button', { name: '打开工作树 api-main', exact: true }).waitFor();
  await settings.getByRole('region', { name: '仓库状态' }).locator('summary').click();
  await settings.locator('.git-settings-refs').getByText('api-main', { exact: true }).waitFor();
  const changed = settings.getByRole('list', { name: '变更文件', exact: true });
  await changed.waitFor();
  assert.equal(await changed.getByText(image, { exact: true }).count(), 0);
  await settings.getByRole('button', { name: '打开 Git 面板' }).click();
  await work.getByText('说明.docx', { exact: true }).waitFor();
  await button('切换分支，当前 api-main').waitFor();
  assert.deepEqual(errors, []);
  console.log('Verified project switching, branches, history, remotes, stable loading geometry, four image versions and document previews.');
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
