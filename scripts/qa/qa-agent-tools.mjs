import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureTestModel, launchTestDesktop, preferenceLayout, selectTestSession } from './fixtures/isolated-desktop.mjs';

const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-agent-tools-')));
const workspace = path.join(temp, 'workspace'), profile = path.join(temp, 'profile');
const output = fileURLToPath(new URL('../../.qa/agent-tools/', import.meta.url));
const serverFile = fileURLToPath(new URL('../../examples/plugins/toolkit-starter/mcp-server.mjs', import.meta.url));
let app, page;
try {
  await Promise.all([workspace, profile, output].map(dir => mkdir(dir, { recursive: true })));
  ({ app, page } = await launchTestDesktop(workspace, profile, 1200, 900));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await configureTestModel(page, workspace, 'http://127.0.0.1:1/v1');
  const result = await page.evaluate(payload => window.piApi.addMcp(payload), {
    cwd: workspace, name: 'studio-qa', transport: 'stdio', command: process.execPath, args: [serverFile],
  });
  assert.equal(result.projection.status, 'ready');
  const method = snapshot => snapshot.mcp.find(server => server.name === 'studio-qa').tools.find(tool => tool.originalName === 'toolkit_echo');
  assert.equal(method(result.projection.value).enabled, true);
  const builtinCopy = new Map(result.projection.value.agentToolCatalog.tools
    .filter(tool => tool.source.kind === 'core').map(tool => [tool.name, tool.description]));
  const id = await page.evaluate(async cwd => (await window.piApi.createConversation({ cwd })).id, workspace);
  await selectTestSession(page, workspace, id);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.sidebar-bottom button[aria-label="设置"]').click();
  const nav = page.locator('.settings-navigation');
  const open = name => nav.getByRole('button', { name, exact: true }).click();
  const tools = page.locator('.agent-tools-settings');
  const general = page.locator('.general-settings-page');
  const groups = tools.locator('.agent-tool-group-trigger');
  const search = tools.getByRole('textbox', { name: '搜索智能体工具' });
  const save = tools.getByRole('button', { name: '保存更改', exact: true });
  const mcp = tools.getByRole('button', { name: '管理 MCP 方法' });
  const enabled = async () => method(await page.evaluate(cwd => window.piApi.settings(cwd), workspace)).enabled;
  async function capture(name) {
    await page.screenshot({ path: path.join(output, name + '.png'), scale: 'css', animations: 'disabled' });
  }
  async function openMethods() {
    await mcp.click();
    await page.getByRole('button', { name: '查看 MCP studio-qa 详情', exact: true }).click();
    const methods = page.locator('.mcp-detail-section').filter({ has: page.locator('summary').filter({ hasText: '工具' }) });
    assert.notEqual(await methods.getAttribute('open'), null, 'a short connected method list opens by default');
  }

  const detail = page.locator('.agent-tool-detail-dialog');
  async function checkStatusAlignment(label) {
    await detail.locator('.agent-tool-detail-state').getByText(label, { exact: true }).waitFor();
    const offsets = await detail.evaluate(dialog => {
      const box = selector => dialog.querySelector(selector).getBoundingClientRect();
      const center = selector => { const rect = box(selector); return rect.y + rect.height / 2; };
      const status = '.agent-tool-detail-state';
      return {
        label: center(status + ' svg') - center(status + ' strong'),
        title: center('.detail-icon svg') - center('h2 code'),
        note: dialog.querySelector(status + ' p') ? box(status + ' p').x - box(status + ' strong').x : 0,
      };
    });
    for (const [key, delta] of Object.entries(offsets)) assert(Math.abs(delta) <= 0.5, label + ' ' + key + ' offset ' + delta);
  }

  async function checkBuiltinDetails(theme) {
    const seen = new Set();
    const sections = tools.locator('.agent-tool-group');
    for (const section of await (theme === '深色' ? sections : sections.filter({ hasText: '电脑操控' })).all()) {
      const trigger = section.locator('.agent-tool-group-trigger');
      if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
      if (theme === '深色' && (await trigger.innerText()).includes('电脑操控')) {
        await section.scrollIntoViewIfNeeded();
        await capture('desktop-tools-dark');
      }
      for (const row of await section.locator('.agent-tool-row').all()) {
        const name = await row.locator('code').innerText();
        if (!builtinCopy.has(name)) continue;
        const description = await row.locator('p').innerText();
        assert.match(description, /\p{Script=Han}/u, name);
        assert.equal(description, builtinCopy.get(name), name);
        await row.getByRole('button', { name: '查看工具 ' + name + ' 详情', exact: true }).click();
        assert.equal(await detail.locator('.detail-heading p').innerText(), description, name);
        seen.add(name);
        if (name === 'desktop_apps') {
          await checkStatusAlignment('已停用');
          await detail.screenshot({ path: path.join(output, theme === '深色' ? 'desktop-apps-dark.png' : 'desktop-apps-light.png'), scale: 'css' });
          await detail.getByRole('button', { name: '加入草稿' }).click();
          await checkStatusAlignment('已启用');
          await detail.getByText('有未保存的更改，保存后生效。', { exact: true }).waitFor();
          await detail.getByRole('button', { name: '从草稿移除' }).click();
          assert.equal(await save.isDisabled(), true, 'restoring the original selection clears the dirty state');
        }
        await detail.getByRole('button', { name: '关闭详情' }).click();
      }
      await trigger.click();
    }
    assert(seen.has('desktop_apps'));
    if (theme === '深色') assert.deepEqual(seen, new Set(builtinCopy.keys()));
  }

  for (const [width, theme] of [[1200, '浅色'], [900, '深色']]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
    await open('通用');
    await general.getByRole('button', { name: theme, exact: true }).click();
    const baseline = await preferenceLayout(general, {
      section: '.preference-group-head h2', control: '.general-radius-options', description: '.general-setting-description', value: '.preference-current-value',
    });
    await open('智能体工具');
    await groups.first().waitFor();
    const actual = await preferenceLayout(tools, {
      section: '.agent-tool-catalog-heading h2', control: '.agent-tool-catalog-heading button', description: '.agent-tool-catalog-heading p', value: '.agent-tool-mcp span',
    });
    assert.deepEqual(actual, baseline, theme + '模式的字体、卡片间距及内外对齐线');
    assert.match(await tools.locator('.agent-tool-group-trigger[aria-expanded="true"]').innerText(), /文件与终端/);
    assert.equal(await tools.locator('.agent-tool-save-bar').evaluate(el => getComputedStyle(el).position), 'static');
    const labels = await groups.locator('> span').allTextContents();
    assert(labels.includes('文件与终端') && labels.includes('浏览器') && labels.includes('任务与协作'));
    if (theme === '浅色') await capture('light');
    await checkBuiltinDetails(theme);
    const fileTools = groups.filter({ hasText: '文件与终端' });
    if (await fileTools.getAttribute('aria-expanded') === 'true') {
      await fileTools.press('Space');
      assert.equal(await fileTools.getAttribute('aria-expanded'), 'false');
    }
    await fileTools.press('Enter');
    await tools.getByRole('button', { name: '查看工具 read 详情', exact: true }).waitFor();
    await search.fill('点击快照');
    assert.equal(await groups.count(), 1);
    assert.equal(await groups.first().getAttribute('aria-expanded'), 'true');
    await tools.getByRole('button', { name: '查看工具 browser_click 详情', exact: true }).waitFor();
    if (theme === '深色') await capture('dark-search');
    await search.fill('mcp__');
    await tools.getByText('没有匹配的工具或命令。', { exact: true }).waitFor();
    await tools.getByRole('button', { name: '清除工具搜索' }).click();
    assert.equal(await groups.filter({ hasText: '文件与终端' }).getAttribute('aria-expanded'), 'true');
    assert.equal(await tools.evaluate(el => el.scrollWidth > el.clientWidth), false);
  }
  await tools.getByRole('switch', { name: '禁用工具 read', exact: true }).click();
  await mcp.click();
  await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑' }).click();
  await tools.getByRole('switch', { name: '允许工具 read', exact: true }).waitFor();
  await tools.getByRole('button', { name: '撤销更改' }).click();
  await openMethods();
  const methodSwitch = page.getByRole('switch', { name: '启用 MCP 方法 toolkit_echo' });
  await methodSwitch.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="启用 MCP 方法 toolkit_echo"]')?.getAttribute('aria-checked') === 'false');
  assert.equal(await enabled(), false);
  await capture('mcp-method');
  await page.getByRole('button', { name: '关闭 MCP 详情' }).click();
  await open('智能体工具');
  await tools.getByRole('button', { name: '恢复推荐配置' }).click();
  await save.click();
  await tools.getByText('与已保存配置一致', { exact: true }).waitFor();
  assert.equal(await enabled(), false);
  await openMethods();
  await methodSwitch.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="启用 MCP 方法 toolkit_echo"]')?.getAttribute('aria-checked') === 'true');
  assert.equal(await enabled(), true);
  assert.deepEqual(errors, []);
  console.log('Verified Chinese list and detail descriptions for ' + builtinCopy.size + ' built-in tools, status icon alignment in both themes, preference layout, search, drafts, and independent MCP method switches.');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), scale: 'css' }).catch(() => {});
  throw error;
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
