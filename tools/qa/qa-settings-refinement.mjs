/**
 * Isolated real-Electron coverage for settings refinement and lazy routes.
 * Run after pnpm run build: node tools/qa/qa-settings-refinement.mjs
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
await mkdir(output, { recursive: true });
const mediaPath = path.join(profile, 'qa-background.png');
await writeFile(mediaPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', 'base64'));
const env = { ...process.env, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'studio.sqlite') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_STUDIO_DEV;

const routes = [
  { label: '通用', title: '通用' },
  { label: '快捷键', title: '快捷键', modules: ['ShortcutSettings'] },
  { label: '模型配置', title: '模型配置', modules: ['ModelSettings'] },
  { label: '使用量', title: 'Token 使用量', modules: ['UsageSettings'] },
  { label: '智能体工具', title: '智能体工具', modules: ['AgentToolsSettings'] },
  { label: '权限策略', title: '智能体权限', modules: ['PermissionPolicySettings'] },
  { label: 'Harness 配置', title: 'Harness 配置', modules: ['HarnessSettings'], glassControls: true },
  { label: '子智能体', title: '子智能体', modules: ['SubagentSettings'] },
  { label: 'MCP 服务器', title: 'MCP 服务器', modules: ['McpSettings'] },
  { label: '技能', title: '技能', modules: ['SkillHub', 'InstalledSkills'] },
  { label: '扩展', title: '扩展', modules: ['OfficialExtensionCatalog', 'PublisherTrustSettings', 'InstalledExtensionsSection'] },
  { label: '归档会话', title: '归档会话', modules: ['ArchivedConversationsSettings'] },
  { label: '关于', title: 'Pi Studio' },
];
const assets = await readdir(path.join(root, 'web-dist', 'assets'));
const routeModules = [...new Set(routes.flatMap((route) => route.modules || []))];
const deferredModules = [
  ...routeModules,
  'RuntimeServicesPanel',
  'ModelComparisonPanel',
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
const result = { pageErrors: [], scriptObservation: 'CDP Debugger.scriptParsed (includes existing scripts when enabled)', coldResources: [], chunks, routes: [], screenshots: [] };
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

async function assertTitleAlignment(label) {
  const geometry = await page.evaluate(() => {
    const nav = document.querySelector('.settings-nav-head').getBoundingClientRect();
    const title = document.querySelector('.settings-content h1').getBoundingClientRect();
    return { navTop: nav.top, titleTop: title.top, navHeight: nav.height, titleHeight: title.height };
  });
  assert.ok(Math.abs(geometry.navTop - geometry.titleTop) <= 1 && Math.abs(geometry.navHeight - geometry.titleHeight) <= 1,
    `${label}: sidebar and page title share a line: ${JSON.stringify(geometry)}`);
}

async function capture(name) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  const geometry = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight,
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    heading: document.querySelector('.settings-content h1')?.textContent,
    back: (() => {
      const box = document.querySelector('.settings-back-button')?.getBoundingClientRect();
      return Boolean(box && box.top >= 0 && box.bottom <= innerHeight + 1);
    })(),
  }));
  assert.equal(geometry.overflow, false, `${name}: no horizontal document overflow`);
  assert.equal(geometry.back, true, `${name}: return-to-conversation stays visible`);
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  result.screenshots.push({ name, ...geometry });
}

try {
  for (const [module, file] of Object.entries(chunks)) assert.ok(file, `production build emits a separate ${module} chunk`);
  app = await _electron.launch({ args: [root], env });
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

  const composer = page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true });
  const draft = '保留这段草稿：检查设置时不发送给模型。';
  await composer.fill(draft);
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  const nav = page.locator('.settings-navigation');
  const content = page.locator('.settings-content');
  const settingsSearch = nav.getByRole('searchbox', { name: '搜索设置', exact: true });
  const generalPage = nav.getByRole('button', { name: '通用', exact: true });
  await content.getByRole('heading', { name: '通用', exact: true }).waitFor();
  assert.equal(await settingsSearch.evaluate((element) => element === document.activeElement), false, 'opening settings does not activate search');
  await page.keyboard.press('Tab');
  assert.equal(await settingsSearch.evaluate((element) => element === document.activeElement), true, 'Tab from the settings heading reaches search');
  const searchFocus = await nav.locator('.settings-navigation-search').evaluate((element) => {
    const style = getComputedStyle(element);
    return { shadow: style.boxShadow, border: style.borderColor, accent: style.getPropertyValue('--settings-accent').trim() };
  });
  assert.match(searchFocus.shadow, /0px 0px 0px 1px/, 'search has a thin focus halo');
  assert.equal(await nav.locator('.settings-nav-row').count(), 13, 'all settings routes remain available');
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
  await capture('01-general-wide-light');
  const sectionSpacing = await content.locator('.general-settings-section').evaluateAll((sections) => sections.map((section, index) => {
    const heading = section.querySelector('h2').getBoundingClientRect();
    const card = section.querySelector('.general-settings-card').getBoundingClientRect();
    return {
      border: getComputedStyle(section).borderTopWidth,
      headingGap: Math.round(card.top - heading.bottom),
      sectionGap: index ? Math.round(section.getBoundingClientRect().top - sections[index - 1].getBoundingClientRect().bottom) : null,
    };
  }));
  // 节奏取设置面自己的令牌，密度调整后断言仍跟着走。
  const rhythmGaps = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.settings-overlay'));
    return {
      heading: parseFloat(style.getPropertyValue('--settings-heading-gap')),
      section: parseFloat(style.getPropertyValue('--settings-section-gap')),
    };
  });
  assert.ok(sectionSpacing.every(({ border, headingGap, sectionGap }) => border === '0px' && headingGap === rhythmGaps.heading && (sectionGap === null || sectionGap === rhythmGaps.section)), `section rhythm: ${JSON.stringify({ sectionSpacing, rhythmGaps })}`);
  result.rhythmGaps = rhythmGaps;
  result.sectionSpacing = sectionSpacing;

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
  await resize(980, 640);
  await content.evaluate((element) => { element.scrollTop = 0; });
  await capture('02-general-minimum-dark');

  await content.getByRole('button', { name: '浅色', exact: true }).click();
  await preference('theme', 'light');
  await capture('03-general-minimum-light');
  await content.getByRole('button', { name: '跟随系统', exact: true }).click();
  await preference('theme', 'system');
  await content.getByRole('button', { name: '深色', exact: true }).click();
  await preference('theme', 'dark');

  // Stubbing the picker result keeps file import/removal on the production IPC path.
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, mediaPath);
  await content.getByRole('button', { name: '选择媒体', exact: true }).click();
  await page.waitForFunction(() => Boolean(JSON.parse(localStorage.getItem('pi-studio:preferences') || '{}').backgroundMedia));
  // 摘要行显示文件名与类型，展开后才是预览与滑杆。
  const backgroundSummary = content.locator('.general-background-summary');
  await backgroundSummary.waitFor();
  assert.match(await backgroundSummary.innerText(), /图片背景/, 'summary labels the media kind');
  const summaryGeometry = await content.evaluate(() => {
    const summary = document.querySelector('.general-background-summary').getBoundingClientRect();
    const preview = document.querySelector('.background-media-preview').getBoundingClientRect();
    const ranges = document.querySelector('.general-background-ranges').getBoundingClientRect();
    const label = document.querySelector('.general-background-ranges .settings-range-copy strong').getBoundingClientRect();
    return {
      summaryHeight: Math.round(summary.height),
      previewTop: Math.round(preview.top - ranges.top),
      previewBottom: Math.round(preview.bottom - ranges.bottom),
      labelOffset: Math.round(label.top - preview.top),
    };
  });
  // 摘要行与普通设置行同高：取同一份行高令牌/实测量，密度调整后仍成立。
  const rowHeight = await content.evaluate(() => {
    const row = document.querySelector('.general-setting-row');
    return row ? Math.round(row.getBoundingClientRect().height) : null;
  });
  assert.ok(summaryGeometry.summaryHeight >= 44 && summaryGeometry.summaryHeight <= 60, `background summary is one setting row tall: ${JSON.stringify(summaryGeometry)}`);
  assert.ok(rowHeight === null || Math.abs(summaryGeometry.summaryHeight - rowHeight) <= 12, `background summary matches the setting row rhythm: ${JSON.stringify({ summary: summaryGeometry.summaryHeight, rowHeight })}`);
  assert.equal(summaryGeometry.previewTop, 0, `preview and sliders share a top edge: ${JSON.stringify(summaryGeometry)}`);
  assert.ok(Math.abs(summaryGeometry.previewBottom) <= 1, `preview and sliders share a bottom edge: ${JSON.stringify(summaryGeometry)}`);
  assert.equal(summaryGeometry.labelOffset, 0, `first slider label starts at the preview top edge: ${JSON.stringify(summaryGeometry)}`);
  result.backgroundGeometry = summaryGeometry;
  const slider = content.getByRole('slider', { name: /背景透明度/ });
  await slider.waitFor();
  assert.equal(await slider.isEnabled(), true);
  await slider.focus();
  await slider.press('ArrowRight');
  await preference('backgroundOpacity', 69);
  await capture('04-background-configured');
  await content.getByRole('button', { name: '移除', exact: true }).click();
  await preference('backgroundMedia', null);
  assert.equal(await content.getByRole('slider').count(), 0, 'removal restores the compact empty state');

  for (const [index, route] of routes.entries()) {
    await nav.getByRole('button', { name: route.label, exact: true }).click();
    await content.getByRole('heading', { name: route.title, exact: true, level: 1 }).waitFor();
    await assertTitleAlignment(`${route.label} narrow`);
    if (route.glassControls) {
      // 有背景图时，输入框、自定义下拉和多行文本必须共用同一块玻璃表面。
      await page.evaluate(() => { document.querySelector('.app').classList.add('has-custom-background'); });
      await page.waitForTimeout(200);
      const surfaces = await page.evaluate(() => {
        const read = (selector) => {
          const node = document.querySelector(selector);
          return node ? getComputedStyle(node).backgroundColor : null;
        };
        return {
          input: read('.settings-content input:not([type="checkbox"]):not([type="radio"])'),
          select: read('.settings-content .pi-select-trigger'),
          textarea: read('.settings-content textarea'),
        };
      });
      await page.evaluate(() => { document.querySelector('.app').classList.remove('has-custom-background'); });
      assert.ok(surfaces.input, `${route.label}: policy inputs are present`);
      assert.equal(surfaces.select, surfaces.input, `${route.label}: select trigger shares the input surface ${JSON.stringify(surfaces)}`);
      assert.equal(surfaces.textarea, surfaces.input, `${route.label}: textarea shares the input surface ${JSON.stringify(surfaces)}`);
      result.glassSurfaces = surfaces;
    }
    await resize(860, 640);
    await assertTitleAlignment(`${route.label} compact`);
    await resize(980, 640);
    assert.equal(await nav.getByRole('button', { name: route.label, exact: true }).getAttribute('aria-current'), 'page');
    for (const module of route.modules || []) {
      assert.ok(loadedScripts.has(chunks[module]), `${module} loads when its settings page is opened`);
    }
    if (route.label !== '关于') {
      const header = content.locator('.settings-page-header').first();
      assert.equal(await header.evaluate((element) => getComputedStyle(element).borderTopWidth), '0px', 'settings page header has no enclosing card border');
    }
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
      await content.locator('.mcp-settings-empty').waitFor();
      assert.doesNotMatch(await content.locator('.settings-page-header').innerText(), /0 个服务器/, 'empty MCP header omits a redundant zero count');
    }
    if (route.label === '技能') {
      await content.locator('.skill-hub-empty').waitFor();
      assert.equal(await content.locator('.skill-hub-head .count-badge').count(), 0, 'empty skill sources omit a redundant zero count');
      assert.equal(await content.getByRole('textbox', { name: '搜索技能源', exact: true }).count(), 0, 'empty skill sources do not expose search without data');
      assert.equal(await content.getByRole('button', { name: '管理源', exact: true }).count(), 0, 'empty skill sources keep source setup in the single empty-state action');
      assert.equal(await content.getByRole('button', { name: '刷新', exact: true }).count(), 0, 'empty skill sources do not offer a no-op refresh');
      assert.equal(await content.getByRole('button', { name: '添加技能源', exact: true }).count(), 1);
    }
    if (route.label === '归档会话') {
      assert.equal(await content.locator('.archive-search').count(), 0, 'archive search appears only after archived sessions exist');
      assert.equal(await content.locator('.archive-result-count').count(), 0, 'empty archive page omits a redundant zero count');
      assert.match(await content.locator('.archive-settings-empty').innerText(), /还没有归档会话/);
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
    await nav.getByRole('button', { name: route.label, exact: true }).click();
    await content.getByRole('heading', { name: route.title, exact: true, level: 1 }).waitFor();
    await assertTitleAlignment(`${route.label} wide`);
    await capture(`route-${String(index + 1).padStart(2, '0')}-wide-light`);
    await nav.getByRole('button', { name: '通用', exact: true }).click();
    await content.getByRole('button', { name: '深色', exact: true }).click();
    await resize(980, 640);
  }
  await nav.getByRole('button', { name: '返回对话', exact: true }).click();
  await composer.waitFor();
  assert.equal(await composer.inputValue(), draft, 'settings edits and lazy navigation preserve the conversation draft');
  assert.equal(await page.locator('.session-row:not(.empty)').count(), 0, 'settings do not submit a conversation');

  await page.reload();
  await page.locator('.new-conversation-welcome').waitFor();
  await preference('theme', 'dark');
  await preference('fontSize', 16);
  await page.locator('.sidebar-bottom button[title="设置"]').click();
  await nav.getByRole('button', { name: '通用', exact: true }).click();
  await content.getByRole('heading', { name: '通用', exact: true }).waitFor();
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
