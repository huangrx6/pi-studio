/** Exercise keyboard dispatch, editing, recovery and layout in an isolated Electron renderer. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchTestDesktop } from './fixtures/isolated-desktop.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.resolve(root, process.env.QA_OUTPUT_DIR || '.qa/screenshots/shortcuts');
const temp = await mkdtemp(path.join(tmpdir(), 'pi-shortcuts-qa-'));
const workspace = path.join(temp, 'workspace'), profile = path.join(temp, 'profile');
await Promise.all([mkdir(workspace), mkdir(profile), mkdir(output, { recursive: true })]);

const { app, page } = await launchTestDesktop(workspace, profile, 1440, 920);
try {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const press = combo => page.keyboard.press(`${mod}+${combo}`);
  const nav = page.locator('.settings-navigation'), content = page.locator('.settings-content');
  const palette = page.getByRole('dialog', { name: '会话动作', exact: true });
  const search = nav.getByRole('searchbox', { name: '搜索设置', exact: true });
  const focused = page.locator(':focus');
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const key = id => content.locator(`[data-shortcut-id="${id}"]`);
  const sidebar = key('toggleSidebar'), panel = key('togglePanel');
  const resetOne = label => content.getByRole('button', { name: `将「${label}」恢复为默认`, exact: true });
  const openSettings = () => page.locator('.sidebar-bottom button[aria-label="设置"]').click();
  const shortcuts = () => nav.getByRole('button', { name: '快捷键', exact: true }).click();
  const toast = page.locator('.settings-toast-stack .settings-toast');
  const capture = async (name, waitForToast = true) => {
    if (waitForToast) await toast.waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled', scale: 'css' });
  };
  const persisted = (id, value) => page.waitForFunction(({ id, value }) =>
    JSON.parse(localStorage.getItem('pi-studio:preferences')).shortcuts[id] === value, { id, value });
  const layout = () => content.evaluate(async node => {
    const frame = node.querySelector('.settings-page-frame');
    await Promise.allSettled(frame.getAnimations().map(animation => animation.finished));
    const cards = node.querySelectorAll('.settings-preference-card');
    const card = cards[0].getBoundingClientRect();
    const inner = cards[0].querySelector('.general-setting-row, .shortcut-row').getBoundingClientRect();
    const rows = Array.from(cards[0].querySelectorAll('.shortcut-row'));
    const typography = selector => {
      const { fontFamily, fontSize, fontWeight, lineHeight } = getComputedStyle(node.querySelector(selector));
      return { fontFamily, fontSize, fontWeight, lineHeight };
    };
    return {
      cards: cards.length,
      shared: {
        title: typography('h1'),
        subtitle: typography('.settings-page-header-meta'),
        body: typography('.general-setting-label h3, .shortcut-label > span'),
        insets: [inner.left - card.left, card.right - inner.right],
      },
      aligned: rows.every(row => Math.abs(row.querySelector('.shortcut-label > span').getBoundingClientRect().left - inner.left) < 1
        && Math.abs(row.querySelector('.shortcut-key').getBoundingClientRect().right - inner.right) < 1),
      headerAligned: Math.abs(node.querySelector('h1').getBoundingClientRect().left - card.left) < 1
        && Math.abs(node.querySelector('.settings-page-header-icon').getBoundingClientRect().right - card.right) < 1,
      rowTops: rows.map(row => Math.round(row.getBoundingClientRect().top + node.scrollTop)),
      overflow: node.scrollWidth - node.clientWidth,
    };
  });

  await page.locator('.new-conversation-welcome').waitFor();
  await press('b'); await page.locator('.app.is-sidebar-collapsed').waitFor();
  await press('b'); await page.locator('.app.is-sidebar-collapsed').waitFor({ state: 'detached' });
  await press('j'); await page.locator('.file-panel.is-open').waitFor();
  await press('j'); await page.locator('.file-panel.is-open').waitFor({ state: 'detached' });
  await press('k'); await palette.waitFor();
  await page.keyboard.press('Escape'); await palette.waitFor({ state: 'hidden' });

  await openSettings();
  await content.getByRole('button', { name: '深色', exact: true }).click();
  await press('k');
  assert.equal(await search.and(focused).count(), 1, 'the palette shortcut focuses search in settings');
  await search.fill('模型');
  const modelSettings = nav.getByRole('button', { name: '模型配置', exact: true });
  await modelSettings.waitFor();
  await press('b');
  await nav.waitFor({ state: 'hidden' });
  await press('k');
  await search.and(focused).waitFor();
  assert.equal(await search.inputValue(), '模型');
  assert.equal(await palette.count(), 0);
  assert.equal(await content.getByRole('heading', { name: '通用', exact: true }).isVisible(), true);
  await page.keyboard.press('Escape');

  await modelSettings.click();
  await content.getByRole('button', { name: '添加模型来源', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '添加模型来源', exact: true });
  const providerName = editor.getByRole('textbox', { name: '显示名称', exact: true });
  await providerName.focus();
  await press('k');
  assert.equal(await providerName.and(focused).count(), 1, 'a modal editor keeps focus');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });

  await nav.getByRole('button', { name: '通用', exact: true }).click();
  await content.getByRole('radiogroup', { name: '强调色' }).getByText('海蓝', { exact: true }).click();
  const generalWide = await layout();
  await shortcuts();
  await sidebar.waitFor();
  const wide = await layout();
  const bindings = content.getByRole('list', { name: '快捷键绑定', exact: true });
  assert.equal(await bindings.getByRole('listitem').count(), 10);
  assert.equal(wide.cards, 1, 'all shortcut bindings share a single card');
  assert.deepEqual(wide.shared, generalWide.shared, 'both pages share type and content insets');
  assert.ok(wide.aligned && wide.headerAligned && wide.overflow === 0);
  await capture('01-overview-dark');

  await content.locator('label.shortcut-label', { hasText: '折叠 / 展开侧栏' }).click();
  assert.equal(await sidebar.getAttribute('aria-pressed'), 'true', 'clicking the action name starts recording');
  await capture('02-recording');
  await press('j');
  const conflict = toast.filter({ hasText: '已被' });
  await conflict.waitFor();
  assert.match(await conflict.innerText(), /已被「折叠 \/ 展开右侧面板」占用/);
  assert.deepEqual((await layout()).rowTops, wide.rowTops, 'a recording conflict preserves the wide layout');
  await capture('03-conflict', false);
  await press('Alt+9');
  await persisted('toggleSidebar', 'Mod+Alt+9');
  assert.deepEqual((await layout()).rowTops, wide.rowTops, 'successful recording keeps all ten actions in place');
  await capture('04-saved');

  await page.locator('[data-sidebar-section="conversations"]').click();
  await press('Alt+9'); await page.locator('.app.is-sidebar-collapsed').waitFor();
  await press('Alt+9'); await page.locator('.app.is-sidebar-collapsed').waitFor({ state: 'detached' });
  await openSettings(); await shortcuts();
  await panel.click(); await press('b'); await persisted('togglePanel', 'Mod+B');
  await resetOne('折叠 / 展开侧栏').click();
  await conflict.waitFor();
  await persisted('toggleSidebar', 'Mod+Alt+9');
  await resetOne('折叠 / 展开右侧面板').click(); await persisted('togglePanel', 'Mod+J');
  assert.equal(await panel.evaluate(button => button === document.activeElement), true);
  await resetOne('折叠 / 展开侧栏').click(); await persisted('toggleSidebar', 'Mod+B');
  assert.equal(await sidebar.evaluate(button => button === document.activeElement), true);
  await capture('05-restored');

  const paletteBinding = key('palette');
  await paletteBinding.click();
  await press('ArrowDown');
  await persisted('palette', 'Mod+ArrowDown');
  await press('k');
  assert.equal(await paletteBinding.and(focused).count(), 1);
  await nav.getByRole('button', { name: '快捷键', exact: true }).focus();
  await press('ArrowDown');
  await search.and(focused).waitFor();
  await resetOne('命令面板').click();
  await persisted('palette', 'Mod+K');

  await nav.getByRole('button', { name: '通用', exact: true }).click();
  await content.getByRole('button', { name: '浅色', exact: true }).click();
  await shortcuts(); await sidebar.waitFor();
  await capture('06-overview-light');
  await content.locator('.shortcut-settings').screenshot({ path: path.join(output, '06-detail-light.png'), scale: 'css', animations: 'disabled' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 760, deviceScaleFactor: 1, mobile: false });
  await nav.getByRole('button', { name: '通用', exact: true }).click();
  await content.locator('.general-settings-page').waitFor();
  const generalNarrow = await layout();
  await shortcuts(); await sidebar.waitFor();
  await sidebar.click(); await press('Alt+Shift+PageDown'); await persisted('toggleSidebar', 'Mod+Alt+Shift+PageDown');
  const narrow = await layout();
  assert.deepEqual(narrow.shared, generalNarrow.shared, 'the shared type and insets also match at narrow widths');
  assert.ok(narrow.aligned && narrow.headerAligned && narrow.overflow === 0, JSON.stringify(narrow));
  await capture('07-narrow');
  await content.getByRole('button', { name: '恢复默认', exact: true }).click();
  await persisted('toggleSidebar', 'Mod+B');
  assert.equal(await sidebar.evaluate(button => button === document.activeElement), true);
  await sidebar.press('Enter');
  assert.equal(await sidebar.getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Tab');
  assert.equal(await panel.evaluate(button => button === document.activeElement), true);
  await panel.press('Space');
  assert.equal(await panel.getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await panel.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(pageErrors, []);
  await writeFile(path.join(output, 'layout.json'), JSON.stringify({ wide, narrow }, null, 2));
  console.log('Shortcut QA passed: single list, typography and insets match General at both sizes, keyboard dispatch, editing and resets.');
} finally {
  try { await app.close(); } finally { await rm(temp, { recursive: true, force: true }); }
}
