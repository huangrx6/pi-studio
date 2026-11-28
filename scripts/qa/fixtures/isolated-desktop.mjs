import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../../../', import.meta.url));

export async function launchTestDesktop(workspace, profile, width, height, { executablePath, extraArgs = [], development = false } = {}) {
  const env = { ...process.env, PI_WORKSPACE: workspace, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'studio.sqlite') };
  delete env.ELECTRON_RUN_AS_NODE;
  if (development) env.PI_STUDIO_DEV = '1';
  else delete env.PI_STUDIO_DEV;
  const args = ['--disable-background-networking', '--use-mock-keychain', ...extraArgs];
  if (!executablePath) args.unshift(root);
  const app = await _electron.launch({ executablePath, args, cwd: workspace, env });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height]);
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !!window.piApi?.createConversation);
    return { app, page };
  } catch (error) {
    await app.close();
    throw error;
  }
}

export async function configureTestModel(page, cwd, baseUrl) {
  await page.evaluate(async ({ baseUrl, cwd }) => {
    const api = window.piApi, providerId = 'desktop-qa', ref = providerId + '/check';
    await api.addProvider({ cwd, providerId, name: '验收模型', api: 'openai-completions', baseUrl, apiKey: 'local-test-only' });
    await api.addCustomModel({ cwd, providerId, modelId: 'check', name: '验收模型', contextWindow: 64000, maxTokens: 1024 });
    await api.setEnabledModels({ cwd, models: [ref] });
    await api.setDefaultModel(ref, cwd);
  }, { baseUrl, cwd });
}

export async function selectTestSession(page, cwd, id) {
  const conversations = page.locator('[data-sidebar-section="conversations"]');
  if (await conversations.getAttribute('aria-current') !== 'page') await conversations.click();
  const tree = await page.evaluate(async target => (await window.piApi.state(target)).workspaces.find(w => w.cwd === target)?.worktree, cwd);
  if (tree) {
    const project = page.locator('[data-sidebar-key=' + JSON.stringify('project:' + tree.projectRoot) + '] > .workspace-row');
    if (await project.getAttribute('aria-expanded') === 'false') await project.click();
  }
  const group = page.locator('[data-workspace-cwd="' + cwd + '"] .workspace-row');
  if (await group.getAttribute('aria-expanded') === 'false') await group.click();
  const row = page.locator('[data-session-id="' + id + '"] .session-row');
  await row.locator('.session-title').click();
  await page.waitForFunction(id => document.querySelector('.session-row.is-active')?.closest('[data-session-id]')?.dataset.sessionId === id, id);
}

export async function assertSettingsRowLinkHover(page, link, rowSelector) {
  const appearance = () => link.evaluate(async (button, rowSelector) => {
    const row = button.closest(rowSelector);
    const animations = row.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity);
    await Promise.allSettled(animations.map(animation => animation.finished));
    const title = button.querySelector('strong, code') ?? button;
    const indicator = button.querySelector('.settings-row-link-indicator');
    return {
      backgrounds: [getComputedStyle(row).backgroundColor, getComputedStyle(button).backgroundColor,
        getComputedStyle(button, '::before').backgroundColor],
      title: getComputedStyle(title).color,
      indicator: getComputedStyle(indicator).color,
    };
  }, rowSelector);
  await page.mouse.move(0, 0);
  const idle = await appearance();
  await link.hover();
  const hovered = await appearance();
  assert.deepEqual(hovered.backgrounds, idle.backgrounds, `${rowSelector} keeps its background on hover`);
  assert.notEqual(hovered.title, idle.title, `${rowSelector} gives feedback on the title`);
  assert.equal(hovered.indicator, hovered.title, `${rowSelector} highlights the title and indicator together`);
}

export function preferenceLayout(root, selectors) {
  return root.evaluate((page, { section, control, description, value }) => {
    const rect = selector => page.querySelector(selector).getBoundingClientRect();
    const type = selector => {
      const style = getComputedStyle(page.querySelector(selector));
      return [style.fontSize, style.fontWeight, style.lineHeight];
    };
    const cards = [...page.querySelectorAll('.settings-preference-card')].map(card => card.getBoundingClientRect());
    return {
      titleLeft: rect('h1').left, iconRight: rect('.settings-page-header-icon').right,
      outerLeft: cards[0].left, outerRight: cards[0].right,
      innerLeft: rect(section).left, innerRight: rect(control).right,
      headerGap: cards[0].top - rect('.settings-page-header').bottom,
      cardGap: cards[1] ? cards[1].top - cards[0].bottom : null,
      titleType: type('h1'), sectionType: type(section), descriptionType: type(description), valueType: value ? type(value) : null,
    };
  }, selectors);
}
