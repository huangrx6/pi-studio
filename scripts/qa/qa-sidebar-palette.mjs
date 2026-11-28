/** Run after pnpm run build. Exercise sidebar colours in the real renderer. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installConversationFixture } from './fixtures/conversation-refinement.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = fileURLToPath(new URL('../../.qa/screenshots/sidebar-palette', import.meta.url));
await mkdir(output, { recursive: true });

async function checkRow(row, backgroundToken) {
  const colors = await row.evaluate(async (button, token) => {
    await Promise.allSettled(button.getAnimations().map(animation => animation.finished));
    const sample = document.createElement('span');
    sample.style.color = 'var(--text)';
    sample.style.backgroundColor = `var(${token})`;
    button.append(sample);
    const expected = getComputedStyle(sample);
    const actual = getComputedStyle(button);
    const glyph = button.querySelector(':scope > svg');
    const values = {
      text: actual.color, background: actual.backgroundColor,
      icon: glyph && getComputedStyle(glyph).color,
      expectedText: expected.color, expectedBackground: expected.backgroundColor,
    };
    sample.remove();
    return values;
  }, backgroundToken);
  assert.equal(colors.text, colors.expectedText, `${row} foreground`);
  if (colors.icon) assert.equal(colors.icon, colors.text, `${row} icon`);
  assert.equal(colors.background, colors.expectedBackground, `${row} background`);
  return colors.background;
}

async function checkSidebarGeometry(page, menuWidth = 256, railWidth = 44) {
  const spacing = await page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const canvas = rect('.content-region > .shell-canvas');
    const firstIcon = rect('.sidebar-rail-sections > button');
    const firstMenuRow = rect('.sidebar-context:not([hidden]) > .nav-row');
    const settings = rect('.sidebar-bottom > button');
    return {
      sidebarWidth: rect('.shell-sidebar.sidebar').width,
      railWidth: rect('.sidebar-rail').width,
      menuWidth: rect('.sidebar-secondary').width,
      navHeight: firstMenuRow.height,
      iconTopInset: firstIcon.top - canvas.top,
      menuTopInset: firstMenuRow.top - canvas.top,
      firstRowHeightDifference: firstIcon.height - firstMenuRow.height,
      settingsHitHeight: settings.height,
      settingsBlockHeight: rect('.studio-statusbar').top - rect('.sidebar-bottom').top,
      settingsCanvasOffset: settings.bottom - canvas.bottom,
    };
  });
  assert.deepEqual(spacing, {
    sidebarWidth: menuWidth + railWidth, railWidth, menuWidth, navHeight: 32,
    iconTopInset: 0, menuTopInset: 0, firstRowHeightDifference: 0,
    settingsHitHeight: 32, settingsBlockHeight: 40, settingsCanvasOffset: 0,
  });
}

async function dragSidebarTo(page, targetWidth) {
  const sidebar = await page.locator('.shell-sidebar.sidebar').boundingBox();
  const handle = await page.getByRole('separator', { name: '调整侧边栏宽度' }).boundingBox();
  const x = Math.round(handle.x + handle.width / 2);
  const y = Math.round(handle.y + handle.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + targetWidth - sidebar.width, y);
  await page.mouse.up();
}

const server = await serveProductionRenderer(root);
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  for (const [mode, label] of [['dark', '深色'], ['light', '浅色']]) {
    const page = await browser.newPage({ viewport: { width: 1690, height: 953 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript({ content: `(${installConversationFixture})();
      window.piApi.files = async (_cwd, path) => ({ path, entries: [] });
      window.piApi.teamProject = async () => ({ bots: [], rooms: [] });
      window.piApi.planList = async () => [];
      window.piApi.planHistory = async () => ({ items: [], cursor: null });
      window.piApi.onPlansChanged = () => () => {};
      window.piApi.openToolWindow = async request => { window.lastTool = request; };
      window.piApi.extensionsUi = async () => ({
        apiVersion: 1, syncedAt: 1, errors: [],
        items: [
          { id: 'qa.review:overview', title: '概览', slot: 'tool.view',
            extensionId: 'qa.review', extensionName: '项目评审', content: [{ kind: 'text', text: '项目评审概览' }] },
          { id: 'qa.review:history', title: '评审记录', slot: 'tool.view',
            extensionId: 'qa.review', extensionName: '项目评审', content: [{ kind: 'text', text: '最近一次评审' }] }
        ]
      });` });
    await page.goto(server.origin);
    await page.locator('.bottom-row').click();
    await page.getByRole('button', { name: '通用', exact: true }).click();
    await page.getByRole('group', { name: '界面模式' }).getByRole('button', { name: label }).click();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, mode);

    const fills = new Set();
    for (const palette of ['amber', 'berry', 'ocean']) {
      await page.locator(`[data-palette-choice="${palette}"]`).click();
      await page.waitForFunction(value => document.documentElement.dataset.palette === value, palette);
      fills.add(await checkRow(page.locator('.settings-nav-row[aria-current="page"]'), '--nav-selected-bg'));
    }
    assert.equal(fills.size, 1, 'sidebar selection is independent of the accent preference');
    await page.mouse.move(1200, 24);
    await page.locator('.settings-toast').waitFor({ state: 'hidden' });
    await page.screenshot({ path: `${output}/settings-${mode}.png`, animations: 'disabled' });

    await page.locator('[data-sidebar-section="conversations"]').click();
    await page.mouse.move(1200, 24);
    const draft = page.locator('.new-chat[aria-current="page"]');
    assert.equal(await draft.locator('svg.lucide-message-circle-plus').count(), 1);
    await checkRow(draft, '--nav-selected-bg');
    await checkSidebarGeometry(page);
    await page.screenshot({ path: `${output}/${mode}.png`, animations: 'disabled' });

    const toolbar = page.locator('.workspace-head');
    const expand = toolbar.getByRole('button', { name: '展开所有工作区', expanded: false });
    const collapse = toolbar.getByRole('button', { name: '收起所有工作区', expanded: true });
    const addWorkspace = toolbar.getByRole('button', { name: '打开工作区' });
    await addWorkspace.locator('svg.lucide-folder-plus').waitFor();
    await expand.locator('svg.lucide-chevrons-right').waitFor();
    if (mode === 'dark') await toolbar.screenshot({ path: `${output}/workspace-toolbar-collapsed.png` });
    await expand.click();
    await collapse.locator('svg.lucide-chevrons-down').waitFor();
    assert.equal(await page.locator('.workspace-row[aria-expanded="true"]').count(), 2);
    assert.equal((await page.locator('.workspace-row').first().boundingBox()).height, 30);
    assert.equal((await page.locator('.session-row').first().boundingBox()).height, 28);
    await page.mouse.move(1200, 24);
    if (mode === 'dark') await toolbar.screenshot({ path: `${output}/workspace-toolbar-expanded.png` });
    await collapse.click();
    await expand.locator('svg.lucide-chevrons-right').waitFor();
    assert.equal(await page.locator('.workspace-row[aria-expanded="false"]').count(), 2);

    await draft.hover();
    await checkRow(draft, '--nav-selected-hover-bg');
    const rail = page.getByRole('navigation', { name: '主导航' });
    const section = (name) => rail.getByRole('button', { name, exact: true });
    const temporary = section('临时对话');
    const settings = section('设置');
    if (mode === 'dark') await page.emulateMedia({ reducedMotion: 'no-preference' });
    await settings.hover();
    await checkRow(settings, '--nav-hover-bg');
    const [selectedBox, hoveredBox] = await rail.locator('button[aria-current="page"], .bottom-row').evaluateAll(buttons =>
      buttons.map(button => {
        const { x, width, height } = button.getBoundingClientRect();
        const { borderWidth, borderRadius, backgroundClip } = getComputedStyle(button);
        return { x, width, height, borderWidth, borderRadius, backgroundClip };
      }));
    assert.deepEqual(hoveredBox, selectedBox, 'hovered settings and the selected section paint the same shape');
    if (mode === 'dark') {
      assert.ok(await settings.evaluate(button => {
        const style = getComputedStyle(button);
        return style.transitionProperty.includes('background') && parseFloat(style.transitionDuration) > 0;
      }), 'settings retains its hover fade');
      await section('对话').screenshot({ path: `${output}/rail-chat-selected.png` });
      await settings.screenshot({ path: `${output}/rail-settings-hover.png` });
      await page.emulateMedia({ reducedMotion: 'reduce' });
    }
    const regularIcon = await draft.locator('svg').evaluate(icon => ({
      width: icon.getBoundingClientRect().width,
      height: icon.getBoundingClientRect().height,
      stroke: getComputedStyle(icon).strokeWidth,
    }));
    for (const button of await rail.getByRole('button').all()) {
      assert.equal(await button.getAttribute('title'), null);
      const rect = await button.boundingBox();
      assert.deepEqual([rect.width, rect.height], [32, 32], 'rail buttons use the same square target as the settings shortcut');
      const glyph = await button.locator('svg').evaluate(icon => ({
        width: icon.getBoundingClientRect().width,
        height: icon.getBoundingClientRect().height,
        stroke: getComputedStyle(icon).strokeWidth,
      }));
      assert.deepEqual(glyph, regularIcon, 'both navigation columns use the same glyph size and weight');
    }
    const hint = page.getByRole('tooltip').filter({ hasText: /^临时对话$/ });
    await temporary.hover();
    await hint.waitFor({ timeout: 450 });
    const triggerBox = await temporary.boundingBox();
    const hintBox = await hint.boundingBox();
    assert.ok(hintBox.x >= triggerBox.x + triggerBox.width &&
      hintBox.y < triggerBox.y + triggerBox.height && hintBox.y + hintBox.height > triggerBox.y,
    'the rail hint opens to the right, aligned with its trigger');
    if (mode === 'dark') await page.screenshot({ path: `${output}/rail-tooltip-dark.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await hint.waitFor({ state: 'hidden' });
    await checkRow(temporary, '--nav-hover-bg');
    await temporary.focus();
    await page.keyboard.press('Shift+Tab');
    assert.ok(await section('对话').evaluate(el => {
      const sample = document.createElement('span');
      sample.style.color = 'var(--muted)';
      el.append(sample);
      const outline = getComputedStyle(el);
      const visible = el.matches(':focus-visible') && outline.outlineStyle === 'solid' && outline.outlineColor === getComputedStyle(sample).color;
      sample.remove();
      return visible;
    }), 'sidebar keyboard focus uses a visible neutral outline');

    await page.keyboard.press('Tab');
    await hint.waitFor({ timeout: 450 });
    const search = page.getByRole('button', { name: '搜索工作区', exact: true });
    await search.hover();
    await page.getByRole('tooltip').filter({ hasText: /^搜索工作区或会话$/ }).waitFor({ timeout: 450 });
    await search.click();
    await checkRow(search, '--nav-selected-hover-bg');
    await page.getByRole('button', { name: '会话筛选' }).click();
    const filter = page.getByRole('option', { selected: true });
    assert.ok(await filter.evaluate(el => getComputedStyle(el).color === getComputedStyle(el.querySelector('svg')).color));
    await page.keyboard.press('Escape');
    await page.getByRole('searchbox', { name: '搜索工作区或会话' }).press('Escape');
    await section('更多').click();
    for (const label of ['插件', '计划', '团队', '手机端']) {
      await rail.getByRole('checkbox', { name: '固定' + label + '到侧边栏' }).check();
    }
    await page.keyboard.press('Escape');
    assert.ok(await section('更多').evaluate(el =>
      el === document.activeElement && getComputedStyle(el).outlineStyle === 'none'),
    'pointer-opened navigation popover returns focus quietly');
    await section('插件').click();
    await page.mouse.move(1200, 24);
    await checkRow(section('插件'), '--nav-selected-bg');
    await checkRow(page.getByRole('button', { name: '插件目录', exact: true }), '--nav-selected-bg');
    await checkSidebarGeometry(page);
    if (mode === 'dark') {
      await page.screenshot({ path: `${output}/plugin-alignment.png`, clip: { x: 0, y: 12, width: 500, height: 216 } });
      await section('设置').hover();
      await page.getByRole('tooltip').filter({ hasText: /^设置$/ }).waitFor();
      await page.screenshot({ path: `${output}/settings-spacing.png`, clip: { x: 0, y: page.viewportSize().height - 116, width: 180, height: 116 } });
      await page.mouse.move(1200, 24);
    }
    assert.equal(await search.isVisible(), false);
    const pluginMenu = page.getByRole('region', { name: '插件菜单' });
    for (const [name, panelId] of [['概览', 'qa.review:overview'], ['评审记录', 'qa.review:history']]) {
      await pluginMenu.getByRole('button', { name, exact: true }).click();
      await page.waitForFunction(id => window.lastTool?.panelId === id, panelId);
      assert.equal(await page.evaluate(() => window.lastTool.kind), 'extension');
    }
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await section('插件').click();
    await pluginMenu.waitFor();

    await section('计划').click();
    await page.getByRole('heading', { name: '执行日程' }).waitFor();
    if (mode === 'dark') await page.screenshot({ path: `${output}/plans-dark.png`, animations: 'disabled' });
    await page.getByRole('button', { name: '运行记录', exact: true }).click();
    await page.getByRole('heading', { name: '暂无运行记录' }).waitFor();

    for (const [module, destinations] of [
      ['团队', ['工作区', 'Bot 成员', '协作看板']],
      ['手机端', ['手机配对', '已配对设备']],
    ]) {
      const entry = section(module);
      await entry.click();
      const menu = page.getByRole('navigation', { name: module + '菜单' });
      assert.deepEqual(await menu.locator(':scope > .nav-row').allTextContents(), destinations);
      assert.equal(await menu.locator('[aria-current="page"]').innerText(), destinations[0]);
      for (const name of destinations.slice(1)) {
        await menu.getByRole('button', { name, exact: true }).click();
        assert.equal(await menu.locator('[aria-current="page"]').innerText(), name);
      }
      await rail.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '返回' + module, exact: true }).click();
      assert.equal(await entry.getAttribute('aria-current'), 'page');
      assert.equal(await menu.locator('[aria-current="page"]').innerText(), destinations.at(-1));
    }

    await temporary.click();
    await page.getByRole('button', { name: '整理评审会的问题' }).click();
    await page.getByText('先确认本次变更影响哪些用户，再讨论验收条件和发布时间。').waitFor();
    await page.mouse.move(1200, 24);
    if (mode === 'dark') await page.screenshot({ path: `${output}/temporary-dark.png`, animations: 'disabled' });
    const newTemporary = page.getByRole('button', { name: '新建临时对话' });
    assert.equal(await newTemporary.locator('svg.lucide-message-circle-plus').count(), 1);
    await newTemporary.click();
    assert.equal(await page.getByText('评审会上有哪些问题值得先讨论？').count(), 0);
    if (mode === 'dark') {
      await page.mouse.move(1200, 24);
      await page.screenshot({ path: `${output}/new-temporary-dark.png`, animations: 'disabled' });
    }
    await section('对话').click();

    const project = page.locator('.workspace').filter({ has: page.getByRole('button', { name: /Beta 文档/ }) });
    await project.locator('.workspace-row').click();
    await project.locator('.session-row').click();
    await page.mouse.move(1200, 24);
    await checkRow(project.locator('.workspace-row.is-active'), '--transparent');
    await checkRow(project.locator('.session-row[aria-current="page"]'), '--nav-selected-bg');
    if (mode === 'dark') {
      await page.setViewportSize({ width: 840, height: 760 });
      await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
      await page.locator('.file-panel.is-overlay').waitFor();
      await section('计划').click();
      await page.locator('.file-panel').waitFor({ state: 'hidden' });
      await page.getByRole('heading', { name: '暂无运行记录' }).waitFor();
      await checkSidebarGeometry(page, 224);
      await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
      await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
      await section('对话').click();
      await checkRow(project.locator('.session-row[aria-current="page"]'), '--nav-selected-bg');
    } else {
      for (const [windowWidth, menuWidth, railWidth] of [[1690, 256, 44], [980, 224, 44], [760, 192, 40]]) {
        await page.setViewportSize({ width: windowWidth, height: 760 });
        await checkSidebarGeometry(page, menuWidth, railWidth);
        if (windowWidth === 760) {
          await dragSidebarTo(page, 200);
          await checkSidebarGeometry(page, 160, railWidth);
        }
        const row = project.locator('.session-row');
        await row.hover();
        assert.ok(await row.evaluate(el => {
          const box = el.getBoundingClientRect();
          return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === el;
        }), 'the row centre opens the conversation even while its actions are visible');
        const actions = project.locator('.session-row-shell > .sidebar-row-actions');
        assert.equal(await actions.locator('button:visible').count(), windowWidth === 760 ? 1 : 3);
        if (windowWidth === 760) {
          await row.focus();
          await page.keyboard.press('Tab');
          const more = actions.getByRole('button', { name: '文档核对的更多操作' });
          assert.ok(await more.evaluate(el => el === document.activeElement));
          await page.keyboard.press('Enter');
          const menu = page.getByRole('menu', { name: '文档核对的操作' });
          await menu.getByRole('menuitem', { name: '归档会话' }).waitFor();
          await menu.getByRole('menuitem', { name: '置顶会话' }).waitFor();
          await page.keyboard.press('Escape');
        }
      }
      await page.setViewportSize({ width: 1690, height: 760 });
      await dragSidebarTo(page, 340);
      await checkSidebarGeometry(page, 296);
      await page.reload();
      await page.locator('.new-chat').waitFor();
      await checkSidebarGeometry(page, 296);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`Sidebar palette checks passed. Screenshots in ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
