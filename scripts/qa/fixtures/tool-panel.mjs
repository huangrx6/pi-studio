import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

/** The tool renderer belongs to a child WebContentsView attached to the main window. */
export async function getToolPanel(app, mainPage) {
  const deadline = Date.now() + 15000;
  do {
    const url = await app.evaluate(({ BrowserWindow, WebContentsView }, mainUrl) => {
      const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === mainUrl);
      const view = host?.contentView.children.find(child =>
        child instanceof WebContentsView && child.webContents.getURL().split('?')[0].endsWith('/tools.html'));
      return view?.webContents.getURL();
    }, mainPage.url());
    const panel = url && mainPage.context().pages().find(page => page.url() === url);
    if (panel) return panel;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error('The main window did not attach a tool WebContentsView with a Playwright page');
}

export async function openToolPanel(app, mainPage, open) {
  await mainPage.locator('.app').waitFor();
  if (open) await open();
  else if (!await mainPage.evaluate(() => window.piApi.toolWindowVisible())) {
    await mainPage.getByRole('button', { name: '打开工具面板', exact: true }).click();
  }
  return getToolPanel(app, mainPage);
}

export async function hideToolPanel(mainPage, panel) {
  await panel.getByRole('button', { name: '收起工具面板', exact: true }).click();
  const deadline = Date.now() + 10000;
  while (await mainPage.evaluate(() => window.piApi.toolWindowVisible())) {
    if (Date.now() >= deadline) throw new Error('The tool panel did not collapse');
    await delay(25);
  }
}

export async function resizeToolHost(app, mainPage, width, height) {
  const host = await app.browserWindow(mainPage);
  try {
    await host.evaluate((window, [w, h]) => window.setContentSize(w, h), [width, height]);
  } finally {
    await host.dispose();
  }
}

export async function openPluginCatalog(page) {
  const navigation = page.getByRole('navigation', { name: '主导航' });
  const plugins = navigation.getByRole('button', { name: '插件', exact: true });
  if (!await plugins.isVisible()) await navigation.getByRole('button', { name: '更多', exact: true }).click();
  await plugins.click();
  await page.getByRole('button', { name: '插件目录', exact: true }).click();
}

/** Opens a plugin through the tool picker and returns its sandbox frame. */
export async function openPluginTool(app, mainPage, title) {
  const page = await openToolPanel(app, mainPage);
  const group = page.locator('.tool-group:visible');
  const picker = group.locator('.tool-picker');
  const active = group.locator('.tool-content:visible iframe');
  if (await active.getAttribute('title', { timeout: 250 }).catch(() => null) !== title) {
    if (await picker.isVisible()) await picker.getByRole('button', { name: title, exact: true }).click();
    else {
      await group.getByRole('button', { name: '新建工具标签页' }).click();
      await page.getByRole('menuitem', { name: title, exact: true }).click();
    }
  }
  const frame = group.frameLocator('iframe.extension-view-frame[title="' + title + '"]:visible');
  await frame.locator('body').waitFor();
  return { page, frame };
}

/** Compare rendered plugin surfaces with the same window's resolved theme, without reopening the view. */
export async function checkPluginTheme(page, frame, surfaces, output) {
  const previous = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    palette: document.documentElement.dataset.palette,
  }));
  try {
    for (const [theme, palette] of [['light', 'ocean'], ['dark', 'ocean'], ['dark', 'berry']]) {
      const expected = await page.evaluate(({ theme, palette, surfaces }) => {
        const root = document.documentElement;
        Object.assign(root.dataset, { theme, palette });
        const probe = document.createElement('span');
        root.append(probe);
        const backgrounds = surfaces.map(([, role]) => {
          probe.style.backgroundColor = 'var(' + role + ')';
          return getComputedStyle(probe).backgroundColor;
        });
        probe.remove();
        return { theme, accent: getComputedStyle(root).getPropertyValue('--accent').trim(), backgrounds };
      }, { theme, palette, surfaces });
      const deadline = Date.now() + 5000;
      let actual;
      do {
        actual = await frame.locator('html').evaluate((root, surfaces) => ({
          theme: root.dataset.theme, accent: getComputedStyle(root).getPropertyValue('--accent').trim(),
          backgrounds: surfaces.map(([selector]) => {
            const node = root.querySelector(selector);
            return node && getComputedStyle(node).backgroundColor;
          }),
        }), surfaces);
        if (JSON.stringify(expected) === JSON.stringify(actual)) break;
        await delay(40);
      } while (Date.now() < deadline);
      assert.deepEqual(actual, expected, 'plugin surfaces: ' + surfaces.map(([selector]) => selector).join(', '));
      if (palette === 'ocean') await page.screenshot({ path: path.join(output, 'studio-' + theme + '.png'), scale: 'css' });
    }
  } finally {
    await page.evaluate(previous => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete document.documentElement.dataset[key];
        else document.documentElement.dataset[key] = value;
      }
    }, previous);
  }
}
