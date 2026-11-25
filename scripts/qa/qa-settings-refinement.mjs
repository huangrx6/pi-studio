import { composerValue } from './fixtures/composer-editor.mjs';
/**
 * Isolated real-Electron coverage for settings refinement and lazy routes.
 * Run after pnpm run build: node scripts/qa/qa-settings-refinement.mjs
 * No conversation is submitted and no provider credential is configured.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa', 'settings-refinement');
const profile = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-settings-'));
const workspace = path.join(profile, 'workspace');
await mkdir(output, { recursive: true });
await mkdir(workspace);
const mediaPath = path.join(profile, 'qa-background.png');
await writeFile(mediaPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', 'base64'));
const env = { ...process.env, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'studio.sqlite') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_STUDIO_DEV;

const routes = [
  { label: '通用', title: '通用' },
  { label: '快捷键', title: '快捷键', modules: ['ShortcutSettings'] },
  { label: 'Git 工作流', title: 'Git 工作流', modules: ['GitSettings'] },
  { label: '模型配置', title: '模型配置', modules: ['ModelSettings'] },
  { label: '使用量', title: 'Token 使用量', modules: ['UsageSettings'] },
  { label: '智能体工具', title: '智能体工具', modules: ['AgentToolsSettings'] },
  { label: '权限策略', title: '权限策略', modules: ['PermissionPolicySettings'] },
  { label: '测试凭据', title: '测试凭据', modules: ['SecretVaultSettings'] },
  { label: 'Harness 配置', title: 'Harness 配置', modules: ['HarnessSettings'], glassControls: true },
  { label: '子智能体', title: '子智能体', modules: ['SubagentSettings'] },
  { label: '插件', title: '插件', hubTab: '插件', modules: ['PluginSettings'] },
  { label: 'MCP 服务器', title: 'MCP 服务器', hubTab: 'MCP', modules: ['McpSettings'] },
  { label: '技能', title: '技能', hubTab: '技能', modules: ['SkillHub', 'InstalledSkills'] },
  { label: '扩展', title: '扩展', hubTab: '扩展', modules: ['PublisherTrustSettings', 'InstalledExtensionsSection'] },
  { label: '网络代理', title: '网络代理', modules: ['NetworkSettings'] },
  { label: '浏览器', title: '浏览器', modules: ['BrowserSettings'] },
  { label: '电脑操控', title: '电脑操控', modules: ['DesktopControlSettings'] },
  { label: '归档会话', title: '归档会话', modules: ['ArchivedConversationsSettings'] },
  { label: '设备存储', title: '设备存储', modules: ['DeviceStorageSettings'] },
  { label: '关于', title: 'Pi Studio' },
];
const assets = await readdir(path.join(root, 'dist/renderer', 'assets'));
const routeModules = [...new Set(routes.flatMap((route) => route.modules || []))];
const deferredModules = [
  ...routeModules,
  'RuntimeServicesPanel',
  'SubagentViews',
  'ConversationImagePreview',
  'FilePreview',
  'MarkdownRenderer',
  'markdown-highlighter',
];
const chunks = Object.fromEntries(deferredModules.map((module) => {
  const file = assets.find((name) => name.startsWith(`${module}-`) && name.endsWith('.js'));
  return [module, file];
}));
const result = { pageErrors: [], scriptObservation: 'CDP Debugger.scriptParsed (includes existing scripts when enabled)', coldResources: [], chunks, routes: [], screenshots: [], backgroundFileAlignment: {} };
let app;
let page;
const loadedScripts = new Set();

async function preference(key, expected) {
  await page.waitForFunction(({ key, expected }) => JSON.parse(localStorage.getItem('pi-studio:preferences') || '{}')[key] === expected, { key, expected });
}

async function resize(width, height) {
  const size = await app.evaluate(({ BrowserWindow }, requested) => {
    const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && item.webContents.getURL().includes('index.html'));
    window.setContentSize(requested.width, requested.height);
    const [width, height] = window.getContentSize();
    return { width, height };
  }, { width, height });
  await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, size);
}

async function assertShellAlignment(label) {
  const geometry = await page.evaluate(async () => {
    await Promise.all([...document.querySelectorAll('.shell-sidebar')].flatMap(sidebar =>
      sidebar.getAnimations().map(animation => animation.finished.catch(() => {}))));
    // Settings now removes the retained workspace from layout. Measure its
    // restored geometry synchronously, without painting it over settings.
    const retained = [...document.querySelectorAll('.app > :is(.sidebar, .content-region)')];
    const styles = retained.map(node => node.getAttribute('style'));
    for (const node of retained) {
      node.style.setProperty('display', node.classList.contains('sidebar') ? 'flex' : 'grid', 'important');
      node.style.setProperty('visibility', 'hidden', 'important');
    }
    try {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const chat = rect('.main');
      const settings = rect('.settings-content');
      const notice = rect('.settings-toast-stack');
      return {
        sidebarWidth: [rect('.sidebar').width, rect('.settings-nav').width],
        headerTop: [rect('.chat-header').top, rect('.settings-header').top],
        headerBottom: [rect('.chat-header').bottom, rect('.settings-header').bottom],
        canvasLeft: [chat.left, settings.left],
        canvasRight: [chat.right, settings.right],
        canvasTop: [chat.top, settings.top],
        canvasBottom: [chat.bottom, settings.bottom],
        columnLeft: [rect('.composer-wrap').left, rect('.settings-page-frame').left],
        columnRight: [rect('.composer-wrap').right, rect('.settings-page-frame').right],
        noticeCenter: [settings.left + settings.width / 2, notice.left + notice.width / 2],
      };
    } finally {
      retained.forEach((node, index) => styles[index] === null ? node.removeAttribute('style') : node.setAttribute('style', styles[index]));
    }
  });
  for (const [edge, [chat, settings]] of Object.entries(geometry)) {
    assert.ok(Math.abs(chat - settings) <= 1, `${label} ${edge}: chat ${chat}, settings ${settings}`);
  }
}

async function dragSidebar(delta) {
  const handle = await page.getByRole('separator', { name: '调整侧边栏宽度' }).boundingBox();
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y);
  await page.waitForFunction(expected => {
    const separator = document.querySelector('.sidebar-resize-handle.is-resizing');
    if (!separator) return false;
    const bounds = separator.getBoundingClientRect();
    return Math.abs(bounds.left + bounds.width / 2 - expected) < 1;
  }, x + delta);
  await page.mouse.up();
}

async function capture(name) {
  await page.locator('.settings-page-frame').evaluate(async frame => {
    // Effects inside a closed disclosure can be suspended indefinitely by Chromium.
    await Promise.allSettled(frame.getAnimations().map(animation => animation.finished));
  });
  const geometry = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight,
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    contentOverflow: document.querySelector('.settings-content').scrollWidth - document.querySelector('.settings-content').clientWidth,
    heading: document.querySelector('.settings-content h1')?.textContent,
    back: (() => {
      const box = document.querySelector('.settings-back-button')?.getBoundingClientRect();
      return Boolean(box && box.top >= 0 && box.bottom <= innerHeight + 1);
    })(),
  }));
  assert.equal(geometry.overflow, false, `${name}: no horizontal document overflow`);
  assert.ok(geometry.contentOverflow <= 1, `${name}: controls fit the settings canvas (${geometry.contentOverflow}px overflow)`);
  assert.equal(geometry.back, true, `${name}: return-to-conversation stays visible`);
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  result.screenshots.push({ name, ...geometry });
}

async function assertCollapsedBackgroundHover(card, summary, mode) {
  const settleHighlight = async row => {
    await new Promise(requestAnimationFrame);
    await Promise.allSettled(row.getAnimations({ subtree: true }).map(animation => animation.finished));
  };
  await page.locator('.settings-toast-stack .settings-toast').waitFor({ state: 'hidden' });
  await card.scrollIntoViewIfNeeded();
  const alignment = await summary.evaluate(row => {
    const rect = selector => row.querySelector(selector).getBoundingClientRect();
    const disclosure = row.closest('.general-settings').querySelector('.preference-disclosure-heading');
    const disclosureRight = selector => disclosure.querySelector(selector).getBoundingClientRect().right;
    const file = rect('.general-background-file');
    const label = rect('.general-background-label');
    const name = row.querySelector('.general-background-name');
    const badge = rect('.pi-accordion-badge');
    const arrow = rect('.pi-accordion-chevron');
    const centers = [label, name.getBoundingClientRect(), badge, arrow].map(box => box.y + box.height / 2);
    return {
      valueRightOffset: badge.right - disclosureRight('.preference-current-value'),
      chevronRightOffset: arrow.right - disclosureRight('svg'),
      badgeToChevronGap: arrow.left - badge.right,
      centerLineSpread: Math.max(...centers) - Math.min(...centers),
      fits: label.right <= file.left && file.right <= arrow.left && name.title === name.textContent,
      filenameTruncated: name.scrollWidth > name.clientWidth,
    };
  });
  assert.ok(Math.abs(alignment.valueRightOffset) < 1 && Math.abs(alignment.chevronRightOffset) < 1
    && alignment.centerLineSpread < 1 && alignment.fits,
    `${mode} background filename, type and chevron alignment: ${JSON.stringify(alignment)}`);
  result.backgroundFileAlignment[mode] = alignment;
  await page.mouse.move(0, 0);
  await summary.evaluate(settleHighlight);
  // CSS-scale element screenshots can move Chromium's hover target on Retina displays.
  const options = { caret: 'initial', scale: 'device' };
  const idle = await card.screenshot(options);
  await summary.hover();
  await summary.evaluate(settleHighlight);
  const hover = await card.screenshot({ ...options, path: path.join(output, `04-background-summary-hover-${mode}.png`) });
  // Measure the painted highlight, independently of the summary's larger hit box.
  const gaps = await app.evaluate(({ nativeImage }, screenshots) => {
    const images = screenshots.map(png => nativeImage.createFromBuffer(Buffer.from(png, 'base64')));
    const { width, height } = images[0].getSize();
    const [before, after] = images.map(image => image.toBitmap());
    let left = width, right = -1, bottom = -1;
    for (let i = 0; i < width * height; i++) {
      if (before.readUInt32LE(i * 4) === after.readUInt32LE(i * 4)) continue;
      const x = i % width;
      left = Math.min(left, x);
      right = Math.max(right, x);
      bottom = Math.floor(i / width);
    }
    return { left, right: width - right - 1, bottom: height - bottom - 1 };
  }, [idle, hover].map(buffer => buffer.toString('base64')));
  const scale = await page.evaluate(() => devicePixelRatio);
  assert.ok(gaps.bottom >= 8 * scale && Math.abs(gaps.bottom - gaps.left) <= scale && Math.abs(gaps.bottom - gaps.right) <= scale,
    `${mode} background disclosure hover has matching side and bottom gutters: ${JSON.stringify(gaps)}`);
}

try {
  for (const [module, file] of Object.entries(chunks)) assert.ok(file, `production build emits a separate ${module} chunk`);
  app = await _electron.launch({ args: [root, '--disable-background-networking', '--use-mock-keychain'], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (error) => result.pageErrors.push(error.message));
  await page.locator('.new-conversation-welcome').waitFor();
  // Chromium omits file:// loads from Resource Timing. CDP reports both existing
  // and subsequent parsed scripts, so this check cannot pass on an empty list.
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Debugger.scriptParsed', ({ url }) => { if (url) loadedScripts.add(decodeURIComponent(url).split('/').at(-1)); });
  await cdp.send('Debugger.enable');
  result.coldResources = [...loadedScripts];
  assert.ok(result.coldResources.some((file) => /^index-.*\.js$/.test(file)), 'CDP observes the production entry script');
  for (const file of Object.values(chunks)) assert.equal(result.coldResources.includes(file), false, `${file} is not loaded on the cold conversation screen`);

  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, workspace);
  await page.getByRole('button', { name: '新对话工作区', exact: true }).click();
  await page.getByRole('option', { name: /打开其他文件夹/ }).click();
  await page.locator('.workspace-choice.has-selection').waitFor();
  const composer = page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true, includeHidden: true });
  const draft = '保留这段草稿：检查设置时不发送给模型。';
  await composer.fill(draft);
  assert.equal(await composerValue(composer), draft, 'draft is entered before opening settings');
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  assert.equal(await composerValue(composer), draft, 'opening settings preserves the hidden editor');
  const nav = page.locator('.settings-navigation');
  const content = page.locator('.settings-content');
  async function openRoute(route) {
    await nav.getByRole('button', { name: route.hubTab ? '插件' : route.label, exact: true }).click();
    if (route.hubTab) {
      await content.getByRole('tablist', { name: '插件与资源' }).getByRole('tab', { name: route.hubTab, exact: true }).click();
    }
    await content.getByRole('heading', { name: route.title, exact: true, level: 1 }).waitFor();
  }
  const settingsSearch = nav.getByRole('searchbox', { name: '搜索设置', exact: true });
  const generalPage = nav.getByRole('button', { name: '通用', exact: true });
  await content.getByRole('heading', { name: '通用', exact: true }).waitFor();
  assert.equal(await settingsSearch.evaluate((element) => element === document.activeElement), false, 'opening settings does not activate search');
  const searchFrame = nav.locator('.settings-navigation-search');
  const idleBorder = await searchFrame.evaluate(element => getComputedStyle(element).borderColor);
  await page.keyboard.press('Tab');
  assert.equal(await settingsSearch.evaluate((element) => element === document.activeElement), true, 'Tab from the settings heading reaches search');
  const searchFocus = await searchFrame.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map(animation => animation.finished));
    const style = getComputedStyle(element);
    return { shadow: style.boxShadow, border: style.borderColor };
  });
  assert.notEqual(searchFocus.border, idleBorder, 'keyboard focus highlights the search border');
  assert.equal(searchFocus.shadow, 'none', 'search draws a single border');
  assert.equal(await nav.locator('.settings-nav-row').count(), routes.filter((route) => !route.hubTab || route.label === '插件').length, 'all sidebar routes remain available');
  assert.equal(await nav.locator('.settings-nav-row[tabindex="0"]').count(), 1, 'one settings page participates in the Tab order');
  assert.equal(await generalPage.getAttribute('tabindex'), '0', 'the active settings page owns the page Tab stop');
  await settingsSearch.fill('模型');
  await settingsSearch.press('ArrowDown');
  const focusedModelPage = nav.getByRole('button', { name: '模型配置', exact: true });
  assert.equal(await focusedModelPage.evaluate((element) => element === document.activeElement), true, 'ArrowDown enters filtered settings results');
  assert.equal(await focusedModelPage.evaluate((element) => element.matches(':focus-visible')), true, 'keyboard-entered settings result keeps a visible focus ring');
  assert.match(await focusedModelPage.evaluate((element) => getComputedStyle(element).boxShadow), /inset/, 'navigation focus uses a single inset ring');
  assert.equal(await nav.locator('.settings-nav-row[tabindex="0"]').count(), 1, 'filtering keeps one settings page Tab stop');
  await focusedModelPage.press('Tab');
  assert.equal(await nav.getByRole('button', { name: '返回对话', exact: true }).evaluate((element) => element === document.activeElement), true, 'Tab from a settings result reaches the back action');
  await settingsSearch.focus();
  await settingsSearch.fill('');
  await settingsSearch.press('ArrowUp');
  assert.equal(await nav.locator('.settings-nav-row').last().evaluate(element => element === document.activeElement), true, 'ArrowUp enters the last search result');
  await settingsSearch.press('ArrowDown');
  assert.equal(await generalPage.evaluate((element) => element === document.activeElement), true, 'ArrowDown enters the unfiltered page list');
  await generalPage.press('ArrowDown');
  const shortcutsPage = nav.getByRole('button', { name: '快捷键', exact: true });
  assert.equal(await shortcutsPage.evaluate((element) => element === document.activeElement), true, 'ArrowDown moves to the next settings page');
  await shortcutsPage.press('End');
  const aboutPage = nav.getByRole('button', { name: '关于', exact: true });
  assert.equal(await aboutPage.evaluate((element) => element === document.activeElement), true, 'End moves to the last settings page');
  await aboutPage.press('Home');
  assert.equal(await generalPage.evaluate((element) => element === document.activeElement), true, 'Home moves to the first settings page');
  await settingsSearch.fill('通用');
  await settingsSearch.press('Escape');
  assert.equal(await settingsSearch.inputValue(), '', 'Escape clears the filter without changing the selected page');
  await settingsSearch.press('ArrowDown');
  assert.equal(await generalPage.getAttribute('aria-current'), 'page');
  assert.equal(await generalPage.evaluate((element) => getComputedStyle(element).outlineStyle), 'none', 'selected keyboard focus does not add a second outline');
  assert.match(await generalPage.evaluate((element) => getComputedStyle(element).boxShadow), /inset/);
  await capture('00-navigation-keyboard-focus');
  await generalPage.press('Escape');
  await composer.waitFor();
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await content.getByRole('heading', { name: '通用', exact: true }).waitFor();
  assert.equal(await nav.locator('[aria-current="page"]').count(), 1, 'reopening settings keeps exactly one selected page');
  assert.equal(await nav.locator('.settings-nav-row:focus-visible').count(), 0, 'Escape and reopening leave no stale navigation focus ring');
  assert.equal(await content.locator('.background-media-empty').count(), 0, 'an empty background does not reserve a media preview');
  assert.equal(await content.getByRole('slider').count(), 0, 'background controls appear only after media selection');
  await resize(1440, 920);
  await assertShellAlignment('default');
  const originalWidth = (await nav.boundingBox()).width;
  await dragSidebar(40);
  await assertShellAlignment('drag from settings');
  assert.equal((await nav.boundingBox()).width, originalWidth + 40);
  await nav.getByRole('button', { name: '返回对话' }).click();
  assert.equal((await page.locator('.sidebar').boundingBox()).width, originalWidth + 40);
  await dragSidebar(-16);
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await content.getByRole('heading', { name: '通用', exact: true }).waitFor();
  const chosenWidth = originalWidth + 24;
  assert.equal((await nav.boundingBox()).width, chosenWidth);
  await nav.getByRole('button', { name: '收起侧边栏' }).click();
  await assertShellAlignment('collapsed');
  await page.locator('.settings-header-back').click();
  await page.locator('.settings-overlay').waitFor({ state: 'detached' });
  const expand = page.getByRole('button', { name: '展开侧边栏' });
  assert.equal(await expand.evaluate(button => button === document.activeElement), true, 'return focus survives a folded sidebar');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  await content.getByRole('heading', { name: '通用', exact: true }).waitFor();
  await assertShellAlignment('open settings from a folded sidebar');
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await assertShellAlignment('expanded');
  // Exercise the narrow renderer breakpoint independently of native window minimums.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 760, deviceScaleFactor: 0, mobile: false });
  await assertShellAlignment('narrow viewport');
  assert.ok((await nav.boundingBox()).width < chosenWidth);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await assertShellAlignment('restored viewport');
  assert.equal((await nav.boundingBox()).width, chosenWidth);
  await capture('01-general-wide-light');
  const group = name => content.getByRole('region', { name, exact: true });
  const disclosure = name => group(name).locator('summary').first();
  async function setGroupOpen(name, open) {
    const details = group(name).locator('details').first();
    if (await details.evaluate(element => element.open) !== open) await disclosure(name).click();
  }
  const generalLayout = element => {
    const groups = [...element.querySelectorAll('.general-settings > .settings-preference-card')];
    const rect = node => node.getBoundingClientRect();
    const first = groups[0], choices = [...first.querySelectorAll('.theme-choice')].map(rect);
    const card = rect(first);
    const art = element.querySelector('.general-tuning-mark');
    const innerLeft = choices[0].left;
    const insets = [innerLeft - card.left, card.right - choices.at(-1).right];
    const colors = [...first.querySelectorAll('.general-palette-option')].map(rect);
    const corners = [...first.querySelectorAll('.general-radius-options button')].map(rect);
    const gap = parseFloat(getComputedStyle(first.parentElement).rowGap);
    return {
      headings: groups.map(group => group.querySelector('h2 [id], h2[id]').textContent),
      titleInset: rect(element.querySelector('h1')).left - card.left,
      artInset: card.right - rect(art).right,
      artSize: rect(art).width,
      sectionsAligned: groups.every(group => Math.abs(rect(group.querySelector('h2')).left - innerLeft) < 1),
      labelsAligned: [...first.querySelectorAll('.general-setting-label')].every(label => Math.abs(rect(label).left - innerLeft) < 1),
      optionsAligned: colors.length === 3 && corners.length === 4
        && Math.abs(colors[0].left - corners[0].left) < 1 && Math.abs(colors.at(-1).right - corners.at(-1).right) < 1
        && colors.every(box => Math.abs(box.width - colors[0].width) < 1 && Math.abs(box.height - corners[0].height) < 1),
      uniformGaps: groups.slice(1).every((group, i) => Math.abs(rect(group).top - rect(groups[i]).bottom - gap) < 1),
      equalChoices: choices.every(choice => Math.abs(choice.width - choices[0].width) < 1),
      insets, gap,
    };
  };
  const assertGeneralLayout = async expectedArtSize => {
    const layout = await content.evaluate(generalLayout);
    assert.deepEqual(layout.headings, ['外观', '背景', '对话', '终端', '应用']);
    assert.ok(Math.abs(layout.titleInset) < 1 && Math.abs(layout.artInset) < 1, JSON.stringify(layout));
    assert.equal(layout.artSize, expectedArtSize, 'general settings artwork is rendered at its intended size');
    assert.ok(layout.sectionsAligned && layout.labelsAligned && layout.optionsAligned && layout.uniformGaps
      && layout.equalChoices && Math.abs(layout.insets[0] - layout.insets[1]) < 1, JSON.stringify(layout));
    return layout;
  };
  result.generalLayout = await assertGeneralLayout(32);
  assert.equal(await content.locator('.settings-section-navigation').count(), 0);

  const palette = group('外观').getByRole('radiogroup', { name: '强调色' });
  assert.deepEqual(await palette.getByRole('radio').evaluateAll(radios => radios.map(radio => radio.value)), ['ocean', 'amber', 'berry']);
  assert.ok(await palette.getByRole('radio', { name: '海蓝', exact: true }).isChecked());
  await palette.screenshot({ path: path.join(output, 'accent-options-light.png'), animations: 'disabled' });
  for (const [name, id] of [['海蓝', 'ocean'], ['珊瑚', 'amber'], ['鸢尾', 'berry']]) {
    await palette.getByText(name, { exact: true }).click();
    await preference('palette', id);
    assert.ok(await palette.locator(`input[value="${id}"]`).isChecked());
    assert.equal(await page.locator('html').getAttribute('data-palette'), id);
    const thumbStroke = await content.locator('.general-tuning-accent').evaluate(thumb => getComputedStyle(thumb).stroke);
    const navAccent = await nav.locator('[aria-current="page"] > svg').evaluate(icon => getComputedStyle(icon).color);
    assert.equal(thumbStroke, navAccent, `the tuning mark uses the selected ${name} accent`);
  }
  const corners = group('外观').getByRole('group', { name: '圆角风格' });
  for (const [label, id] of [['柔和', 'soft'], ['直角', 'square'], ['紧凑', 'compact'], ['标准', 'standard']]) {
    await corners.getByRole('button', { name: label, exact: true }).click();
    await preference('radiusStyle', id);
    assert.ok(await group('外观').evaluate(card =>
      getComputedStyle(card).borderTopLeftRadius === getComputedStyle(document.documentElement).getPropertyValue('--radius-card').trim()));
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await group('对话').locator('details').evaluate(details => getComputedStyle(details, '::details-content').transitionDuration), '0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('.settings-toast-stack .settings-toast').waitFor({ state: 'hidden' });
  await corners.getByRole('button', { pressed: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.settings-toast-stack .settings-toast').count(), 0, 'selecting the current value does not report a new save');

  const conversationTitle = group('对话').locator('h2 span[id]').first();
  await setGroupOpen('对话', false);
  const baseline = await conversationTitle.boundingBox();
  await disclosure('对话').hover();
  assert.equal((await conversationTitle.boundingBox()).x, baseline.x, 'hover keeps the text edge');
  await disclosure('对话').focus();
  await page.keyboard.press('Enter');
  await group('对话').getByRole('button', { name: '增加字号' }).waitFor({ state: 'visible' });
  assert.equal((await conversationTitle.boundingBox()).x, baseline.x, 'opening keeps the text edge');

  await content.getByRole('button', { name: '深色', exact: true }).click();
  await preference('theme', 'dark');
  await settingsSearch.focus();
  await capture('01b-search-focus-dark');
  const increaseFontSize = content.getByRole('button', { name: '增加字号', exact: true });
  await increaseFontSize.click();
  await increaseFontSize.click();
  await preference('fontSize', 16);
  assert.match(await content.getByRole('button', { name: /^字号：/ }).innerText(), /16/);
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--chat-font-size')), '16px');
  // 步进器：点击数值直接输入，回车确认并夹到上界 18；方向键步进。
  const fontSizeValue = content.getByRole('button', { name: /^字号：/ });
  await fontSizeValue.click();
  const fontSizeInput = content.getByRole('textbox', { name: '字号数值', exact: true });
  await fontSizeInput.fill('40');
  await fontSizeInput.press('Enter');
  await preference('fontSize', 18);
  assert.match(await fontSizeValue.innerText(), /18/);
  assert.equal(await increaseFontSize.isDisabled(), true, '上界禁用增加');
  await fontSizeValue.focus();
  await fontSizeValue.press('ArrowDown');
  await preference('fontSize', 17);
  await fontSizeValue.press('ArrowDown');
  await preference('fontSize', 16);
  assert.match(await fontSizeValue.innerText(), /16/);
  await group('对话').getByRole('button', { name: '详细', exact: true }).click();
  await preference('stepDisplay', 'detailed');
  await group('对话').getByRole('button', { name: '工作步骤收起时机' }).click();
  await page.getByRole('option', { name: '保持展开' }).click();
  await preference('stepCollapse', 'keep-open');
  await group('对话').getByRole('switch', { name: '显示代码工作视图' }).click();
  await preference('showCodeView', true);
  await disclosure('对话').press('Space');
  assert.match(await disclosure('对话').innerText(), /16 px · 详细步骤/);
  await setGroupOpen('终端', true);
  await group('终端').getByRole('button', { name: '终端配色主题' }).click();
  await page.getByRole('option', { name: 'Nord', exact: true }).click();
  await preference('terminalTheme', 'nord');
  await group('终端').getByRole('button', { name: '下划线', exact: true }).click();
  await preference('terminalCursorStyle', 'underline');
  await group('终端').getByRole('button', { name: '终端字体', exact: true }).click();
  await page.getByRole('option', { name: 'Menlo', exact: true }).click();
  await preference('terminalFontFamily', 'Menlo');
  await group('终端').getByRole('button', { name: '增加终端字号' }).click();
  await group('终端').getByRole('button', { name: '增加终端行高' }).click();
  const sample = group('终端').locator('.general-terminal-preview');
  assert.equal(await sample.getAttribute('data-terminal-theme'), 'nord');
  assert.ok(await sample.locator('[data-shape="underline"]').isVisible());
  assert.ok(await sample.locator('samp').evaluate(samp => {
    const prefs = JSON.parse(localStorage.getItem('pi-studio:preferences'));
    const style = getComputedStyle(samp);
    return style.fontFamily.startsWith('Menlo') && parseFloat(style.fontSize) === prefs.terminalFontSize
      && Math.abs(parseFloat(style.lineHeight) - prefs.terminalFontSize * prefs.terminalLineHeight) < 0.01;
  }));
  await capture('01c-general-terminal-preview');
  await disclosure('对话').click();
  const segmentedLabels = ['强调色', '圆角风格', '工作步骤展示', '终端光标形状'];
  for (const narrow of [false, true]) {
    if (narrow) await cdp.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 760, deviceScaleFactor: 0, mobile: false });
    const controls = await content.evaluate((element, labels) => labels.map(label => {
      const control = element.querySelector(`.settings-segments[aria-label="${label}"]`);
      const labelBox = control.closest('.general-setting-row').querySelector('.general-setting-label').getBoundingClientRect();
      const box = control.getBoundingClientRect();
      const options = Array.from(control.children, option => option.getBoundingClientRect());
      return {
        label, width: box.width, right: box.right, stacked: box.top >= labelBox.bottom,
        even: options.every(option => Math.abs(option.width - options[0].width) < 1 && option.top === options[0].top),
      };
    }), segmentedLabels);
    for (const control of controls) {
      assert.ok(control.width > 0 && Math.abs(control.width - controls[0].width) < 1
        && Math.abs(control.right - controls[0].right) < 1, `${control.label}: equal width and alignment`);
      assert.ok(control.even && control.stacked === narrow, `${control.label}: equal options and responsive layout`);
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await disclosure('对话').click();
  await disclosure('终端').click();
  assert.match(await disclosure('终端').innerText(), /Nord/);
  await resize(980, 640);
  await content.evaluate((element) => { element.scrollTop = 0; });
  await capture('02-general-minimum-dark');

  await content.getByRole('button', { name: '浅色', exact: true }).click();
  await preference('theme', 'light');
  await capture('03-general-minimum-light');
  await content.getByRole('button', { name: '跟随系统', exact: true }).click();
  await preference('theme', 'system');
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction(scheme => document.documentElement.dataset.theme === scheme, colorScheme);
    assert.equal(await content.getByRole('button', { name: '跟随系统' }).getAttribute('aria-pressed'), 'true');
  }
  await page.emulateMedia({ colorScheme: null });
  await content.getByRole('button', { name: '深色', exact: true }).click();
  await preference('theme', 'dark');

  // Stubbing the picker result keeps file import/removal on the production IPC path.
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, process.env.QA_BACKGROUND_PATH || mediaPath);
  await content.getByRole('button', { name: '选择媒体', exact: true }).click();
  await page.waitForFunction(() => Boolean(JSON.parse(localStorage.getItem('pi-studio:preferences') || '{}').backgroundMedia));
  // 摘要行显示文件名与类型，展开后才是预览与滑杆。
  const backgroundSummary = content.locator('.general-background-summary');
  await backgroundSummary.waitFor();
  await assertShellAlignment('custom background');
  assert.match(await backgroundSummary.innerText(), /图片/, 'summary labels the media kind');
  await page.evaluate(async () => {
    await Promise.allSettled(document.querySelector('.general-background-settings').getAnimations({ subtree: true }).map(animation => animation.finished));
  });
  const summaryGeometry = await content.evaluate(() => {
    const summary = document.querySelector('.general-background-summary').getBoundingClientRect();
    const preview = document.querySelector('.background-media-preview').getBoundingClientRect();
    const card = document.querySelector('.general-background-settings').closest('.settings-preference-card').getBoundingClientRect();
    const ranges = document.querySelector('.general-background-ranges').getBoundingClientRect();
    const tracks = [...document.querySelectorAll('.general-background-ranges input')].map(input => input.getBoundingClientRect());
    return {
      summaryHeight: Math.round(summary.height),
      previewHeight: Math.round(preview.height),
      previewCenterOffset: preview.x + preview.width / 2 - (card.x + card.width / 2),
      rangeGap: Math.round(ranges.top - preview.bottom),
      leftOffset: Math.round(Math.min(...tracks.map(track => track.left)) - preview.left),
      rightOffset: Math.round(Math.max(...tracks.map(track => track.right)) - preview.right),
    };
  });
  const otherDisclosure = await disclosure('对话').boundingBox();
  assert.ok(summaryGeometry.summaryHeight >= 44 && summaryGeometry.summaryHeight <= 60, `background summary is one setting row tall: ${JSON.stringify(summaryGeometry)}`);
  assert.ok(Math.abs(summaryGeometry.summaryHeight - otherDisclosure.height) <= 1, 'background and section disclosures have the same hit height');
  assert.ok(summaryGeometry.previewHeight > 0 && summaryGeometry.rangeGap >= 8, `preview appears above the controls: ${JSON.stringify(summaryGeometry)}`);
  assert.ok(Math.abs(summaryGeometry.previewCenterOffset) < 1, 'wallpaper preview is centered in its card');
  assert.ok(Math.abs(summaryGeometry.leftOffset) <= 1 && Math.abs(summaryGeometry.rightOffset) <= 1, 'preview and controls share a content width');
  result.backgroundGeometry = summaryGeometry;
  const slider = content.getByRole('slider', { name: '透明度', exact: true });
  await slider.waitFor();
  assert.equal(await slider.isEnabled(), true);
  await slider.focus();
  await slider.press('ArrowRight');
  await preference('backgroundOpacity', 69);
  await capture('04-background-configured');

  const rangeGrid = group('背景').locator('.general-background-range-grid');
  const assertRangeLayout = async columns => {
    const layout = await rangeGrid.evaluate(grid => {
      const rect = node => node.getBoundingClientRect();
      const preview = rect(document.querySelector('.background-media-preview'));
      const inputs = [...grid.querySelectorAll('input')];
      const tracks = inputs.map(rect);
      return {
        columns: tracks.filter(track => track.top === tracks[0].top).length,
        previewOffsets: [Math.min(...tracks.map(t => t.left)) - preview.left, preview.right - Math.max(...tracks.map(t => t.right))],
        insetAndAligned: inputs.every(input => {
          const row = input.closest('label'), box = rect(row), track = rect(input);
          const left = track.left - box.left, right = box.right - track.right;
          return left >= 8 && Math.abs(left - right) < 1 && track.height >= 24
            && Math.abs(rect(row.querySelector('strong')).left - track.left) < 1
            && Math.abs(rect(row.querySelector('output')).right - track.right) < 1;
        }),
        clearInputs: inputs.every(input => getComputedStyle(input).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(input).backgroundImage === 'none'),
      };
    });
    assert.equal(layout.columns, columns, JSON.stringify(layout));
    assert.ok(layout.previewOffsets.every(offset => Math.abs(offset) < 1) && layout.insetAndAligned && layout.clearInputs, JSON.stringify(layout));
    return layout;
  };
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 760, deviceScaleFactor: 0, mobile: false });
  result.generalLayoutNarrow = await assertGeneralLayout(28);
  result.rangeLayoutNarrow = await assertRangeLayout(1);
  await backgroundSummary.click();
  await assertCollapsedBackgroundHover(group('背景'), backgroundSummary, 'narrow');
  await backgroundSummary.press('Enter');
  await slider.waitFor();
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await resize(1440, 920);
  await palette.getByText('海蓝', { exact: true }).click();
  result.rangeLayoutWide = await assertRangeLayout(2);
  await slider.press('End');
  await preference('backgroundOpacity', 100);
  await slider.press('Home');
  await preference('backgroundOpacity', 0);
  await slider.click();
  await preference('backgroundOpacity', 50);
  const bounds = await slider.boundingBox();
  const trackY = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + bounds.width / 2, trackY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width, trackY, { steps: 8 });
  await page.mouse.up();
  await preference('backgroundOpacity', 100);
  await slider.fill('32');
  await content.getByRole('slider', { name: '遮罩' }).fill('32');
  await content.getByRole('slider', { name: '窗口内' }).fill('9');
  await backgroundSummary.click();
  for (const [mode, label] of [['dark', '深色'], ['light', '浅色']]) {
    await content.getByRole('button', { name: label, exact: true }).click();
    await preference('theme', mode);
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, mode);
    await page.locator('.settings-toast-stack .settings-toast').waitFor({ state: 'hidden' });
    await page.mouse.move(0, 0);
    await content.evaluate(el => { el.scrollTop = 0; });
    await capture(`04-general-wallpaper-${mode}`);
    await assertCollapsedBackgroundHover(group('背景'), backgroundSummary, mode);
    await backgroundSummary.click({ position: { x: 24, y: summaryGeometry.summaryHeight - 3 } });
    await slider.waitFor();
    await group('背景').scrollIntoViewIfNeeded();
    // The outer strip of padding must receive hover even during normal accordion styling.
    const row = rangeGrid.locator('label').first();
    await row.hover({ position: { x: 3, y: 12 } });
    await page.waitForFunction(() => {
      const row = document.querySelector('.settings-range-control');
      return row.matches(':hover') && getComputedStyle(row).backgroundColor !== 'rgba(0, 0, 0, 0)';
    });
    await assertRangeLayout(2);
    await group('背景').screenshot({ path: path.join(output, `04-background-hover-${mode}.png`), animations: 'disabled' });
    await backgroundSummary.click();
  }
  await resize(980, 640);
  await content.getByRole('button', { name: '深色', exact: true }).click();
  await backgroundSummary.click();
  await group('背景').getByRole('button', { name: '恢复默认' }).click();
  await preference('backgroundOpacity', 68);
  await backgroundSummary.click();
  await content.locator('.background-media-preview').waitFor({ state: 'detached' });
  await backgroundSummary.click();
  await slider.waitFor();
  await content.getByRole('button', { name: '移除', exact: true }).click();
  await preference('backgroundMedia', null);
  assert.equal(await content.getByRole('slider').count(), 0, 'removal restores the compact empty state');

  for (const [index, route] of routes.entries()) {
    assert.equal(await composerValue(composer), draft, `draft retained before ${route.label}`);
    await openRoute(route);
    await assertShellAlignment(`${route.label} narrow`);
    if (route.glassControls) {
      await page.evaluate(() => { document.querySelector('.app').classList.add('has-custom-background'); });
      const surface = locator => locator.first().evaluate(node => getComputedStyle(node).backgroundColor);
      await content.getByRole('button', { name: '全局运行策略', exact: true }).click();
      const policy = content.getByRole('dialog', { name: '全局运行策略' });
      await policy.locator('.harness-policy-group > summary').first().click();
      const input = await surface(policy.locator('input[type="number"]'));
      const select = await surface(policy.locator('.pi-select-trigger'));
      await policy.getByRole('button', { name: '取消', exact: true }).click();
      await policy.waitFor({ state: 'detached' });
      await content.locator('.settings-profile-card').first().click();
      const profile = content.getByRole('dialog', { name: '编辑 Harness 配置' });
      await profile.locator('.harness-extra-instructions > summary').click();
      const textarea = await surface(profile.getByLabel('Harness 附加指令'));
      await profile.getByRole('button', { name: '取消', exact: true }).click();
      await profile.waitFor({ state: 'detached' });
      await page.evaluate(() => { document.querySelector('.app').classList.remove('has-custom-background'); });
      assert.equal(select, input, 'Harness 下拉框和输入框使用相同的表面');
      assert.equal(textarea, input, 'Harness 文本域和输入框使用相同的表面');
      result.glassSurfaces = { input, select, textarea };
    }
    await resize(860, 640);
    await assertShellAlignment(`${route.label} compact`);
    await resize(980, 640);
    assert.equal(await nav.getByRole('button', { name: route.hubTab ? '插件' : route.label, exact: true }).getAttribute('aria-current'), 'page');
    for (const module of route.modules || []) {
      assert.ok(loadedScripts.has(chunks[module]), `${module} loads when its settings page is opened`);
    }
    const header = content.locator('.settings-page-header').first();
    assert.equal(await header.evaluate((element) => getComputedStyle(element).borderTopWidth), '0px', 'settings page header has no enclosing card border');
    if (route.label === '扩展') {
      const actionsFit = await content.locator('.settings-page-header').evaluate((header) => {
        const box = header.getBoundingClientRect();
        return [...header.querySelectorAll('button')].every((button) => {
          const buttonBox = button.getBoundingClientRect();
          return buttonBox.left >= box.left - 1 && buttonBox.right <= box.right + 1;
        });
      });
      assert.equal(actionsFit, true, 'extension page header actions wrap inside the minimum-width content');
    }
    if (route.label === '使用量') {
      await content.locator('.usage-empty-state').waitFor();
      assert.equal(await content.locator('.usage-hero, .usage-heatmap-card, .usage-models-card').count(), 0, 'zero usage does not render an empty analytics workbench');
      assert.equal(await content.getByRole('group', { name: '热力图日期范围', exact: true }).count(), 0, 'zero usage does not offer a range switch without data');
    }
    if (route.label === 'MCP 服务器') {
      await content.getByRole('heading', { name: '还没有 MCP 服务器' }).waitFor();
      assert.doesNotMatch(await content.locator('.settings-page-header').innerText(), /0 个服务器/, 'empty MCP header omits a redundant zero count');
    }
    if (route.label === '技能') {
      await content.getByRole('heading', { name: '还没有技能源' }).waitFor();
      assert.equal(await content.locator('.skill-hub-card h2 > span').count(), 0, 'empty skill sources omit a redundant zero count');
      assert.equal(await content.getByRole('button', { name: '搜索技能', exact: true }).count(), 0, 'empty skill sources do not expose search without data');
      assert.equal(await content.getByRole('button', { name: '管理源', exact: true }).count(), 0, 'empty skill sources keep source setup in the single empty-state action');
      assert.equal(await content.getByRole('button', { name: '刷新技能源', exact: true }).count(), 0, 'empty skill sources do not offer a no-op refresh');
      assert.equal(await content.getByRole('button', { name: '添加技能源', exact: true }).count(), 1);
    }
    if (route.label === '归档会话') {
      assert.equal(await content.locator('.archive-search').count(), 0, 'archive search appears only after archived sessions exist');
      assert.equal(await content.locator('.archive-result-count').count(), 0, 'empty archive page omits a redundant zero count');
      await content.getByRole('heading', { name: '还没有归档会话' }).waitFor();
    }
    if (route.label === '技能' || route.label === '扩展') {
      assert.equal(await content.locator('.settings-page-header .count-badge').count(), 0, `${route.label} keeps counts in the content section they describe`);
    }
    result.routes.push({
      label: route.label,
      title: route.title,
      loadedChunks: (route.modules || []).map((module) => chunks[module]),
    });
    await capture(`route-${String(index + 1).padStart(2, '0')}`);
    // Review every page in a wide light window as well as the narrow dark window.
    await nav.getByRole('button', { name: '通用', exact: true }).click();
    await content.getByRole('button', { name: '浅色', exact: true }).click();
    await resize(1440, 920);
    await openRoute(route);
    await assertShellAlignment(`${route.label} wide`);
    await capture(`route-${String(index + 1).padStart(2, '0')}-wide-light`);
    await nav.getByRole('button', { name: '通用', exact: true }).click();
    await content.getByRole('button', { name: '深色', exact: true }).click();
    await resize(980, 640);
  }
  await nav.getByRole('button', { name: '返回对话', exact: true }).click();
  await composer.waitFor();
  assert.equal(await composerValue(composer), draft, 'settings edits and lazy navigation preserve the conversation draft');
  assert.equal(await page.locator('.session-row:not(.empty)').count(), 0, 'settings do not submit a conversation');

  await page.reload();
  await page.locator('.new-conversation-welcome').waitFor();
  assert.equal((await page.locator('.sidebar').boundingBox()).width, chosenWidth, 'sidebar width survives reload');
  await preference('theme', 'dark');
  await preference('fontSize', 16);
  await preference('palette', 'ocean');
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await nav.getByRole('button', { name: '通用', exact: true }).click();
  await content.getByRole('heading', { name: '通用', exact: true }).waitFor();
  assert.match(await disclosure('对话').innerText(), /16 px · 详细步骤/);
  await setGroupOpen('对话', true);
  assert.match(await content.getByRole('button', { name: /^字号：/ }).innerText(), /16/);

  assert.deepEqual(result.pageErrors, [], 'no uncaught renderer errors');
  console.log(`Settings refinement QA passed: ${result.routes.length} routes, ${Object.keys(chunks).length} lazy chunks; screenshots: ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  try { if (app) await app.close(); } finally { await rm(profile, { recursive: true, force: true }); }
}
