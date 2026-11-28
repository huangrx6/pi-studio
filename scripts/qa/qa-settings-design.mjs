/** Verify the production settings layout and regressions in an isolated Electron profile after pnpm run build. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSettingsRowLinkHover, configureTestModel, launchTestDesktop, preferenceLayout } from './fixtures/isolated-desktop.mjs';

const output = fileURLToPath(new URL('../../.qa/settings-redesign/', import.meta.url));
const base = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-settings-design-'));
const workspace = path.join(base, 'workspace');
const profile = path.join(base, 'profile');
await Promise.all([workspace, profile, output].map(dir => mkdir(dir, { recursive: true })));

const views = [
  ['general', '通用'], ['shortcuts', '快捷键'], ['models', '模型配置'],
  ['usage', 'Token 使用量'], ['tools', '智能体工具'], ['permissions', '权限策略'],
  ['harness', 'Harness 配置'], ['subagents', '子智能体'], ['plugins', '插件'],
  ['mcp', 'MCP 服务器'], ['skills', '技能'], ['extensions', '扩展'],
  ['git', 'Git'], ['network', '网络代理'], ['browser', '浏览器'],
  ['desktop-control', '电脑操控'], ['secrets', '测试凭据'], ['archives', '归档会话', 'archives'], ['about', 'Pi Studio'],
  ['storage', '设备存储'],
];

const dataPageControls = {
  network: ['.network-modes', '.network-help'],
  browser: ['.preference-row-control .switch', '.preference-row-copy p'],
  'desktop-control': ['.preference-row-control .switch', '.preference-row-copy p'],
  secrets: ['.secret-vault-submit button', '.secret-vault-hint'],
  archives: ['.archive-spotlight img', '.settings-spotlight-copy p'],
  about: ['.preference-group-actions button', '.preference-group-head p'],
};

const hubViews = new Set(['mcp', 'skills', 'extensions']);
const result = { screens: [], checks: [], pageErrors: [] };
let app;
let page;

try {
  execFileSync('git', ['init', '--quiet', '-b', 'main'], {
    cwd: workspace, env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' },
  });
  ({ app, page } = await launchTestDesktop(workspace, profile, 1240, 850));
  page.on('pageerror', error => result.pageErrors.push(error.message));
  const content = page.locator('.settings-content');
  const nav = page.locator('.settings-navigation');
  const cdp = await page.context().newCDPSession(page);
  const preferenceFold = name => content.getByRole('region', { name, exact: true }).locator('.preference-disclosure');
  const openSettings = () => page.locator('.sidebar-bottom button[aria-label="设置"]').click();
  const hubTab = name => content.getByRole('tablist', { name: '插件与资源' }).getByRole('tab', { name, exact: true });
  const hubTabLabels = { plugins: '插件', mcp: 'MCP', skills: '技能', extensions: '扩展' };
  async function go(id, title) {
    await nav.locator(`[data-settings-page="${hubViews.has(id) ? 'plugins' : id}"]`).click();
    if (id in hubTabLabels) await hubTab(hubTabLabels[id]).click();
    await content.getByRole('heading', { name: title, level: 1, exact: true }).waitFor();
    if (id === 'plugins') await content.getByRole('region', { name: '插件目录', exact: true }).waitFor();
    if (id === 'desktop-control') await content.getByRole('heading', { name: '系统权限', level: 2 }).waitFor();
    if (id === 'browser') await content.getByRole('button', { name: '管理浏览历史' }).waitFor();
  }
  async function theme(name, value) {
    await go('general', '通用');
    await content.getByRole('button', { name, exact: true }).click();
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, value);
    await page.locator('.settings-toast-stack .settings-toast').waitFor({ state: 'hidden' });
  }
  async function screenshot(name) {
    await page.evaluate(async () => {
      const animations = document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity);
      await Promise.allSettled(animations.map(animation => animation.finished));
    });
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  }
  async function verifyExit(dialog, dismiss) {
    await dialog.evaluate(element => {
      window.settingsExitObserved = false;
      const observer = new MutationObserver(() => {
        if (!element.hasAttribute('data-modal-closing')) return;
        observer.disconnect();
        window.settingsExitObserved = element.open && element.matches(':modal');
      });
      observer.observe(element, { attributes: true });
    });
    await dismiss();
    await dialog.waitFor({ state: 'detached' });
    assert.ok(await page.evaluate(() => window.settingsExitObserved));
  }
  function selectionAppearance(option, pseudo = null) {
    return option.evaluate((node, pseudo) => {
      const { backgroundColor, boxShadow } = getComputedStyle(node, pseudo);
      return { backgroundColor, boxShadow };
    }, pseudo);
  }

  await app.evaluate(({ dialog }, cwd) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
  }, workspace);
  await page.getByRole('button', { name: '打开工作区', exact: true }).click();
  await page.locator('[data-workspace-cwd]').waitFor();
  await configureTestModel(page, workspace, 'http://127.0.0.1:1/v1');
  await openSettings();
  for (const [mode, modeName, size] of [['light', '浅色', 'wide'], ['dark', '深色', 'wide'], ['dark', '深色', 'narrow']]) {
    await theme(modeName, mode);
    if (size === 'narrow') {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 760, deviceScaleFactor: 1, mobile: false });
    }
    let generalLayout;
    for (const [id, title, illustration] of views) {
      await go(id, title);
      await content.evaluate(element => { element.scrollTop = 0; });
      if (id === 'general') await content.locator('.general-tuning-mark[aria-hidden="true"]').waitFor();
      const art = content.locator('.settings-spotlight img');
      if (illustration) {
        await art.waitFor({ state: 'attached' });
        await art.evaluate(image => image.decode());
        assert.equal(await art.count(), 1, `${id} has one illustration`);
        assert.ok(await art.evaluate(image => image.alt === '' && image.width <= 120 && image.naturalWidth === 320),
          `${id} illustration loads at the settings size`);
      }
      if (id === 'general') {
        for (const name of ['对话', '终端', '应用']) assert.notEqual(await preferenceFold(name).getAttribute('open'), null, name);
        generalLayout = await preferenceLayout(content, { section: '.preference-group-head h2',
          control: '.general-radius-options', description: '.general-setting-description' });
      } else if (dataPageControls[id]) {
        const [control, description] = dataPageControls[id];
        await content.locator(control).first().waitFor();
        const actual = await preferenceLayout(content, { section: '.settings-preference-card h2', control, description });
        if (id === 'browser') {
          actual.headerGap = await content.evaluate(node =>
            node.querySelector('.browser-quick-strip').getBoundingClientRect().top
            - node.querySelector('.settings-page-header').getBoundingClientRect().bottom);
        }
        for (const [key, value] of Object.entries(actual)) {
          const label = `${id} ${mode}/${size} ${key}`;
          if (typeof value === 'number') assert.ok(Math.abs(value - generalLayout[key]) < 0.5, `${label}: ${value} vs ${generalLayout[key]}`);
          else if (value !== null) assert.deepEqual(value, generalLayout[key], label);
        }
      }
      const measurement = await page.waitForFunction(title => {
        const element = document.querySelector('.settings-content');
        const header = element?.querySelector('.settings-page-header');
        const heading = header?.querySelector('h1');
        if (heading?.textContent !== title) return false;
        const headerBounds = header.getBoundingClientRect();
        const fits = [...header.querySelectorAll('button')].every(button => {
          const bounds = button.getBoundingClientRect();
          return bounds.left >= headerBounds.left - 1 && bounds.right <= headerBounds.right + 1;
        });
        return { width: innerWidth, height: innerHeight, overflow: element.scrollWidth - element.clientWidth, fontSize: getComputedStyle(heading).fontSize, fits };
      }, title);
      const layout = await measurement.jsonValue();
      await measurement.dispose();
      assert.ok(layout.overflow <= 1 && layout.fits, `${id} ${mode}/${size} overflows: ${JSON.stringify(layout)}`);
      const rhythm = await content.evaluate(root => {
        const shown = selector => [...root.querySelectorAll(selector)].filter(node => node.checkVisibility());
        const height = node => node.offsetHeight;
        const font = node => {
          const style = getComputedStyle(node);
          return [style.fontSize, style.fontWeight, style.lineHeight].join('/');
        };
        return {
          fields: shown('.pi-select-trigger, input[type="password"], .model-list-search input, .plugin-catalog-search input').map(height),
          rowHeights: shown('.preference-row, .preference-disclosure > summary').map(height),
          labels: [...new Set(shown('.preference-row-copy h3').map(font))],
          descriptions: [...new Set(shown('.preference-row-copy p').map(font))],
        };
      });
      const sample = `${id} ${mode}/${size}`;
      assert.ok(rhythm.fields.every(height => height === 40), `${sample} single-line fields: ${rhythm.fields}`);
      assert.ok(rhythm.rowHeights.every(height => height >= 44), `${sample} row hit area: ${rhythm.rowHeights}`);
      assert.ok(rhythm.labels.every(font => font === '13px/500/19.5px'), `${sample} labels: ${rhythm.labels}`);
      assert.ok(rhythm.descriptions.every(font => font === '12px/400/18px'), `${sample} descriptions: ${rhythm.descriptions}`);
      assert.ok(await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '对话', exact: true }).isVisible());
      const name = `${mode}-${size}-${id}`;
      await screenshot(name);
      if (id === 'browser') {
        const categories = content.locator('.preference-group-row');
        assert.equal(await categories.count(), 3);
        for (const group of await categories.all()) {
          const summary = group.locator('summary');
          const detail = group.locator('details');
          assert.equal(await detail.evaluate(node => node.open), false);
          await summary.press('Enter');
          assert.notEqual(await detail.getAttribute('open'), null);
          const fields = group.locator('.preference-group-body');
          await fields.waitFor();
          assert.ok(await fields.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'expanded browser controls fit the card');
          await summary.press('Enter');
        }
      }
      if (id === 'skills') {
        await screenshot(`${name}-sources`);
      }
      result.screens.push({ id, title, mode, size, name, illustration, ...layout });
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  for (const size of ['wide', 'narrow']) {
    assert.equal(new Set(result.screens.filter(screen => screen.size === size).map(screen => screen.fontSize)).size, 1, `all ${size} page titles share a font size`);
  }

  await go('general', '通用');
  const terminal = preferenceFold('终端');
  await terminal.locator('summary').press('Enter');
  await terminal.locator('.general-terminal-preview').waitFor({ state: 'hidden' });
  assert.notEqual(await preferenceFold('对话').getAttribute('open'), null);
  assert.notEqual(await preferenceFold('应用').getAttribute('open'), null);
  await terminal.locator('summary').press('Space');
  await terminal.locator('.general-terminal-preview').waitFor();

  const policy = content.locator('.permission-policy');
  const harness = content.locator('.harness-settings');
  const savePolicy = policy.getByRole('button', { name: '保存权限策略', exact: true });
  const savedPolicy = () => page.evaluate(async () => (await window.piApi.permissionPolicyGet({})).scopes.user);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const [mode, name] of [['light', '浅色'], ['dark', '深色']]) {
    await theme(name, mode);
    if (mode === 'dark') {
      await content.getByRole('radiogroup', { name: '强调色' }).getByText('海蓝', { exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.palette === 'ocean');
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      }, fileURLToPath(new URL('../../website/assets/studio-ribbon.webp', import.meta.url)));
      await content.getByRole('button', { name: '选择媒体', exact: true }).click();
      await page.locator('.app.has-custom-background').waitFor();
      await page.locator('.background-layer img').evaluate(image => image.decode());
    }
    const baseline = await preferenceLayout(content.locator('.general-settings-page'), {
      section: '.preference-group-head h2', control: '.general-radius-options',
      description: '.general-setting-description', value: '.preference-current-value',
    });
    const generalSelection = await selectionAppearance(content.getByRole('group', { name: '圆角风格' }).getByRole('button', { pressed: true }));
    const paletteSelection = await selectionAppearance(content.getByRole('radiogroup', { name: '强调色' }).locator('label:has(> input:checked)'));
    await go('harness', 'Harness 配置');
    await harness.getByRole('button', { name: '新建配置' }).waitFor();
    const cards = harness.locator('.harness-workspace');
    const cardEdges = await cards.evaluate(node => {
      const header = node.closest('.harness-settings').querySelector('.settings-page-header').getBoundingClientRect();
      return [node.getBoundingClientRect().left - header.left, node.getBoundingClientRect().right - header.right];
    });
    assert.ok(cardEdges.every(delta => Math.abs(delta) < 1));
    await cards.getByRole('button', { name: /^编辑/ }).first().click();
    const profileDialog = harness.getByRole('dialog', { name: '编辑 Harness 配置' });
    const harnessScope = profileDialog.getByRole('group', { name: 'Harness 应用范围' }).getByRole('button', { pressed: true });
    await harnessScope.hover();
    const harnessSelection = await selectionAppearance(harnessScope);
    assert.equal(await profileDialog.locator('details[open].harness-composition').count(), 1);
    assert.equal(await profileDialog.locator('details[open]').count(), 1);
    const disclosure = profileDialog.locator('.harness-composition > summary');
    const edges = () => disclosure.evaluate(node => [
      node.querySelector('.pi-accordion-label').getBoundingClientRect().left,
      node.querySelector('.pi-accordion-chevron').getBoundingClientRect().right,
    ]);
    const aligned = await edges();
    await disclosure.hover();
    assert.deepEqual(await edges(), aligned, 'hover preserves both content edges');
    await assertSettingsRowLinkHover(page, profileDialog.locator('.harness-section-toggle').first(), '.harness-section-row');
    await profileDialog.getByRole('button', { name: '取消', exact: true }).click();
    await go('permissions', '权限策略');
    const modes = policy.locator('.permission-preset');
    await modes.first().waitFor();
    const scopeAppearance = await selectionAppearance(policy.getByRole('group', { name: '权限作用域' }).getByRole('button', { pressed: true }));
    assert.match(scopeAppearance.boxShadow, /inset/, 'the reference selection has an inset border');
    assert.deepEqual(generalSelection, scopeAppearance, mode + ' general selection uses the scope appearance');
    assert.deepEqual(paletteSelection, scopeAppearance, mode + ' palette radio uses the scope appearance');
    assert.deepEqual(harnessSelection, scopeAppearance, mode + ' hovering the selected Harness range preserves the scope appearance');
    const layout = await preferenceLayout(policy, { section: '#permission-scope-title', control: '.permission-policy-scopes',
      description: '.permission-policy-section-head p', value: '.permission-save-state > span' });
    assert.deepEqual(layout, baseline, mode + ' permission and general page alignment and type');
    assert.equal(await policy.locator('details[open], input[type=password]').count(), 0);
    assert.equal(await savePolicy.isDisabled(), true);
    const appearances = [];
    for (const name of ['请求批准', '完全权限', '帮我批准']) {
      const option = modes.filter({ has: page.getByText(name, { exact: true }) });
      await option.click();
      if (name === '完全权限') {
        await page.getByRole('alertdialog', { name: '启用完全权限？' }).getByRole('button', { name: '启用完全权限', exact: true }).click();
      }
      assert.equal(await option.getAttribute('aria-pressed'), 'true');
      appearances.push(await option.evaluate(node => {
        const style = getComputedStyle(node), check = getComputedStyle(node.querySelector('.permission-preset-check'));
        return [style.backgroundColor, style.boxShadow, check.borderColor, check.backgroundColor];
      }));
      const edges = await option.evaluate(node => [
        node.querySelector('strong').getBoundingClientRect().left,
        node.querySelector('.permission-preset-check').getBoundingClientRect().right,
      ]);
      assert.deepEqual(edges, [baseline.innerLeft, baseline.innerRight], mode + ' selected row edges');
      if (name === '完全权限') {
        await content.evaluate(node => { node.scrollTop = 0; });
        await page.mouse.move(0, 0);
        await screenshot('permission-full-' + mode);
      }
    }
    assert.deepEqual(appearances[1], appearances[0], mode + ' full access uses the same selection colors');
    assert.deepEqual(appearances[2], appearances[0], mode + ' assisted approval uses the same selection colors');
    assert.equal(await savePolicy.isDisabled(), true, 'returning to the saved mode clears the draft');

    await go('subagents', '子智能体');
    await content.getByRole('button', { name: '共用运行默认值' }).click();
    const defaults = page.getByRole('dialog', { name: '共用运行默认值' });
    const scopes = defaults.getByRole('group', { name: '子智能体配置范围' });
    const globalScope = scopes.getByRole('button', { name: '所有工作区' });
    const workspaceScope = scopes.getByRole('button', { name: '指定工作区' });
    const widths = () => scopes.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().width));
    await globalScope.waitFor();
    assert.equal(await globalScope.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await selectionAppearance(globalScope), scopeAppearance, mode + ' subagent scope matches the reference');
    await globalScope.hover();
    assert.deepEqual(await selectionAppearance(globalScope), scopeAppearance, mode + ' hovering the selected subagent range preserves the appearance');
    const scopeWidths = await widths();
    assert.ok(Math.abs(scopeWidths[0] - scopeWidths[1]) < 1, 'subagent ranges are equal width');
    await defaults.getByRole('region', { name: '配置范围' }).screenshot({ path: path.join(output, `subagent-scope-${mode}.png`), animations: 'disabled' });
    assert.ok(await workspaceScope.isEnabled(), 'the fixture workspace is available');
    await workspaceScope.press('Enter');
    await defaults.getByRole('button', { name: '子智能体目标工作区' }).waitFor();
    assert.equal(await workspaceScope.getAttribute('aria-pressed'), 'true');
    assert.equal(await globalScope.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await widths(), scopeWidths, 'moving the check does not resize the scope control');
    await workspaceScope.hover();
    assert.deepEqual(await selectionAppearance(workspaceScope), scopeAppearance, mode + ' the second scope uses the same appearance');
    await page.keyboard.press('Escape');
    await defaults.waitFor({ state: 'detached' });

    await go('git', 'Git');
    await assertSettingsRowLinkHover(page, content.locator('.git-tree-open'), '.git-worktree-row');
    await content.getByRole('region', { name: '差异显示' }).waitFor();
    const diffLayout = content.getByRole('group', { name: '默认差异布局' }).getByRole('button', { pressed: true });
    assert.deepEqual(await selectionAppearance(diffLayout), scopeAppearance, mode + ' Git layout matches the reference');

    await go('models', '模型配置');
    const source = content.locator('[data-provider-id="desktop-qa"]');
    await assertSettingsRowLinkHover(page, source.locator('.model-source-manage'), '.model-settings-provider');

    await go('tools', '智能体工具');
    const openTools = content.locator('.agent-tool-group-trigger[aria-expanded="true"]');
    await openTools.waitFor();
    assert.match(await openTools.innerText(), /文件与终端/);
    await assertSettingsRowLinkHover(page, content.locator('.agent-tool-open').first(), '.agent-tool-row');

    await go('plugins', '插件');
    const pluginTabs = content.getByRole('tablist', { name: '插件与资源' });
    await pluginTabs.getByRole('tab', { selected: true }).hover();
    assert.deepEqual(await selectionAppearance(pluginTabs, '::before'), scopeAppearance, mode + ' sliding tab indicator matches the reference');
  }
  result.checks.push('Shared segmented selection across in-dialog scopes, permission scopes, Harness, General, Git and plugin tabs in both themes');
  result.checks.push('Common settings are visible on entry and keyboard toggles keep sibling groups independent');
  result.checks.push('Model sources, Git worktrees, agent tools and Harness links give title and chevron feedback without a hover fill in both themes');

  await go('permissions', '权限策略');
  await policy.locator('.permission-overrides > summary').press('Enter');
  await policy.getByLabel('工具或通配符', { exact: true }).fill('custom_tool');
  await policy.getByRole('button', { name: '新工具覆盖的权限决定', exact: true }).click();
  await screenshot('action-permission-select');
  await page.getByRole('option', { name: '拒绝', exact: true }).click();
  await policy.getByRole('button', { name: '添加覆盖', exact: true }).click();
  await policy.locator('.permission-overrides > summary').click();
  await policy.locator('.permission-policy-preview > summary').click();
  await policy.getByRole('button', { name: '预览工具', exact: true }).click();
  await page.getByRole('option', { name: 'custom_tool', exact: true }).click();
  await policy.getByRole('button', { name: '预览结果', exact: true }).click();
  await policy.locator('.permission-preview-result header strong').filter({ hasText: /^拒绝$/ }).waitFor();
  assert.equal((await savedPolicy()).tools.custom_tool, undefined, 'preview does not save the draft');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 760, deviceScaleFactor: 1, mobile: false });
  await policy.locator('.permission-overrides > summary').click();
  await savePolicy.scrollIntoViewIfNeeded();
  assert.equal(await policy.locator('.permission-policy-actions').evaluate(node => getComputedStyle(node).position), 'static');
  assert.ok(await content.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'expanded rule and preview fit a narrow desktop');
  const previewEdges = await policy.locator('.permission-preview-form').evaluate(form =>
    [form, form.querySelector('.pi-select-trigger'), form.lastElementChild].map(node => node.getBoundingClientRect().right));
  assert.ok(Math.max(...previewEdges) - Math.min(...previewEdges) < 1, 'preview fields and button share the right inset on narrow windows');
  await screenshot('permission-rules-narrow');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await savePolicy.click();
  await page.locator('.settings-toast-stack').getByRole('status').filter({ hasText: '权限策略已保存' }).waitFor();
  assert.equal((await savedPolicy()).tools.custom_tool, 'deny');
  await policy.getByRole('button', { name: '恢复默认', exact: true }).click();
  await page.getByRole('alertdialog', { name: '恢复默认权限策略？' }).getByRole('button', { name: '恢复默认', exact: true }).click();
  await page.locator('.settings-toast-stack').getByRole('status').filter({ hasText: '已恢复默认权限策略' }).waitFor();
  result.checks.push('Permission scopes, settings geometry, all three mode treatments in light and dark with wallpaper, preview, saved override and reset');

  const secretSearch = nav.getByRole('searchbox', { name: '搜索设置' });
  await secretSearch.fill('凭据');
  assert.equal(await nav.locator('[data-settings-page]').count(), 1);
  await go('secrets', '测试凭据');
  await secretSearch.fill('');
  const vault = content.locator('.secret-vault-page');
  await vault.getByLabel('名称', { exact: true }).fill('QA_DESIGN');
  await vault.getByLabel('值', { exact: true }).fill('local-fixture-only');
  await vault.getByRole('button', { name: '保存凭据', exact: true }).click();
  await vault.getByText('{{secret:QA_DESIGN}}', { exact: true }).waitFor();
  await page.locator('.settings-toast-stack').getByRole('status').filter({ hasText: '凭据 QA_DESIGN 已加密保存' }).waitFor();
  assert.equal(await vault.getByLabel('值', { exact: true }).inputValue(), '');
  await vault.getByRole('button', { name: '删除凭据 QA_DESIGN', exact: true }).click();
  await page.getByRole('alertdialog', { name: '删除凭据 QA_DESIGN？' }).getByRole('button', { name: '删除凭据', exact: true }).click();
  await vault.getByText('还没有保存测试凭据。', { exact: true }).waitFor();
  await page.locator('.settings-toast-stack').getByRole('status').filter({ hasText: '凭据 QA_DESIGN 已删除' }).waitFor();
  result.checks.push('Credential search opens its own page and supports encrypted save and confirmed removal');
  await go('general', '通用');
  await content.getByRole('button', { name: '移除', exact: true }).click();
  await page.locator('.app.has-custom-background').waitFor({ state: 'detached' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await theme('浅色', 'light');
  const search = nav.getByRole('searchbox', { name: '搜索设置' });
  await search.fill('MCP');
  await nav.locator('[data-settings-page="mcp"]').click();
  await content.getByRole('heading', { name: 'MCP 服务器', level: 1 }).waitFor();
  await search.fill('');
  await hubTab('插件').focus();
  await page.keyboard.press('ArrowRight');
  assert.ok(await hubTab('MCP').evaluate(tab => tab === document.activeElement));
  await hubTab('MCP').press('Enter');
  assert.equal(await hubTab('MCP').getAttribute('aria-selected'), 'true');
  await content.getByRole('button', { name: '浏览插件' }).click();
  await content.getByRole('region', { name: '插件目录', exact: true }).waitFor();
  const marketCard = content.getByRole('button', { name: '查看插件 Excalidraw', exact: true });
  await marketCard.focus();
  await page.keyboard.press('Enter');
  const detail = page.getByRole('dialog', { name: '插件 Excalidraw' });
  await detail.waitFor();
  for (const key of ['Tab', 'Shift+Tab', 'Tab', 'Tab']) {
    await page.keyboard.press(key);
    assert.ok(await detail.evaluate(dialog => dialog.contains(document.activeElement)), `focus remains in the market detail after ${key}`);
  }
  await screenshot('action-plugin-detail');
  await verifyExit(detail, () => page.keyboard.press('Escape'));
  assert.ok(await marketCard.evaluate(button => button === document.activeElement));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await marketCard.click();
  await detail.waitFor();
  assert.equal(await detail.locator('.detail-dialog').evaluate(card => getComputedStyle(card).animationName), 'none');
  await detail.getByRole('button', { name: '关闭', exact: true }).click();
  await detail.waitFor({ state: 'detached' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  result.checks.push('Nested settings search, resource tabs, native detail focus, escape, exit and reduced motion');

  await go('browser', '浏览器');
  await content.getByRole('region', { name: '联系信息', exact: true }).locator('summary').click();
  const addContact = content.getByRole('region', { name: '联系信息', exact: true }).getByRole('button', { name: '添加', exact: true });
  await addContact.click();
  const contact = page.getByRole('dialog', { name: '添加联系人', exact: true });
  await contact.getByRole('textbox', { name: '姓名', exact: true }).fill('QA contact');
  assert.equal(await contact.getByRole('textbox', { name: '姓名', exact: true }).evaluate(node => node.offsetHeight), 40);
  await screenshot('action-browser-contact');
  await verifyExit(contact, () => contact.getByRole('button', { name: '保存联系人', exact: true }).click());
  await page.getByText('已保存联系信息', { exact: true }).waitFor();
  await content.getByText('QA contact', { exact: true }).waitFor();
  assert.ok(await addContact.evaluate(button => button === document.activeElement));
  result.checks.push('A settings form keeps its native modal barrier through the successful save exit and restores focus');

  const historyKey = 'pi.studio.browser.history.v1';
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify([{ url: 'https://example.invalid/', title: 'QA visit', visitedAt: 1 }])), historyKey);
  await content.getByRole('button', { name: '管理浏览历史' }).click();
  await page.getByRole('dialog', { name: '历史记录' }).getByText('QA visit').waitFor();
  await openSettings();
  await go('browser', '浏览器');
  await content.getByRole('button', { name: '清除浏览数据', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: '清除浏览数据？' });
  await confirmation.getByText(/最近访问记录/).waitFor();
  await screenshot('action-browser-confirm');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await confirmation.waitFor({ state: 'detached' });
  assert.match(await page.evaluate(key => localStorage.getItem(key), historyKey), /QA visit/);
  await content.getByRole('button', { name: '清除浏览数据', exact: true }).click();
  await confirmation.getByRole('button', { name: '清除数据', exact: true }).click();
  await page.getByText('已清除浏览数据', { exact: true }).waitFor();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), historyKey), null);
  await content.getByRole('button', { name: '管理浏览历史' }).click();
  await page.getByRole('dialog', { name: '历史记录' }).getByText('还没有访问记录').waitFor();
  const guestTabs = page.getByRole('tablist', { name: '浏览器标签' }).getByRole('tab');
  const tabCount = await guestTabs.count();
  await openSettings();
  await go('browser', '浏览器');
  await content.getByRole('button', { name: '管理下载历史' }).click();
  await page.getByRole('dialog', { name: '下载', exact: true }).getByText('还没有下载').waitFor();
  assert.ok(await page.getByRole('button', { name: '下载', exact: true }).evaluate(button => button === document.activeElement));
  assert.equal(await guestTabs.count(), tabCount);
  result.checks.push('Settings history and downloads open the existing browser; profile cleanup clears recent visits');

  assert.deepEqual(result.pageErrors, []);
  console.log(`Settings design QA passed (${result.screens.length} views across themes and widths; ${result.checks.length} interaction groups).`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  try { if (app) await app.close(); } finally { await rm(base, { recursive: true, force: true }); }
}
