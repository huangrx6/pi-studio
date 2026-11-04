/**
 * Focused browser QA for icon and toolbar geometry consistency.
 *
 * Proves that the right-panel tab bar and the shared file-preview toolbar use the
 * same icon-button box, the same icon size and the same icon colour, and that the
 * preview/source segmented control uses that same geometry.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node tools/qa/qa-icon-consistency.mjs
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/icon-consistency/', import.meta.url).pathname;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 640 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.route('**/popover-preview', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="UTF-8"></head><body style="margin:0;background:var(--bg)"><div id="fixture"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/app.css');
      await import('/src/shell/right-panel/right-panel.css');
      await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/styles.css');
      await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/captions/captions.css');
      await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/counter/counter.css');
      await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/thumbnails/thumbnails.css');
      const React = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
      const { PanelTabBar } = await import('/src/shell/right-panel/PanelTabBar.tsx');
      const { FilePreview } = await import('/src/shared/FilePreview.tsx');
      const { ConversationImageGallery } = await import('/src/features/conversation/ConversationImageGallery.tsx');
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#192126'; ctx.fillRect(0, 0, 320, 200);
      const shot = canvas.toDataURL('image/png');
      const { MoreHorizontal } = await import('/@fs/${process.cwd()}/node_modules/.vite/deps/lucide-react.js');
      const tabs = [{ id: 'file:1', kind: 'file', title: 'README.md' }];
      const toolActions = [
        { id: 'files', label: '文件', onSelect: () => {} },
        { id: 'terminal', label: '终端', onSelect: () => {} },
      ];
      const file = {
        path: '/workspace/pi-studio/README.md',
        name: 'README.md',
        size: 72,
        mimeType: 'text/markdown',
        kind: 'text',
        text: '# Pi Studio\\n\\n工作区文件预览。\\n\\n- Markdown 渲染\\n- 源码切换\\n',
      };
      function Fixture() {
        return React.createElement('div', { style: { width: '520px' } },
          React.createElement(PanelTabBar, {
            tabs, activeId: 'file:1', workspaceName: 'pi-studio', fullscreen: false, split: false, resizing: false,
            toolActions,
            onActivate: () => {}, onClose: () => {}, onReorder: () => {}, onContextMenu: () => {},
            onToggleSplit: () => {}, onToggleFullscreen: () => {}, onCollapse: () => {},
            onMakeDragPreview: () => {}, onClearDragPreview: () => {},
          }),
          React.createElement(FilePreview, {
            file,
            onOpenExternal: () => {},
            actions: React.createElement('button', { className: 'icon-button', 'aria-label': '文件操作', title: '文件操作' },
              React.createElement(MoreHorizontal)),
          }),
          React.createElement(ConversationImageGallery, {
            images: [{ src: shot, alt: '预览一' }, { src: shot, alt: '预览二' }],
          }));
      }
      createRoot(document.getElementById('fixture')).render(React.createElement(Fixture));
    </script></body></html>`,
  }));

  await page.goto('http://127.0.0.1:5180/popover-preview', { waitUntil: 'domcontentloaded' });
  await page.locator('.file-preview-toolbar').waitFor();
  await page.locator('.panel-tabbar .icon-button').first().waitFor();

  const geometry = () => page.evaluate(() => {
    const read = (node) => {
      const box = node.getBoundingClientRect();
      const icon = node.querySelector('svg');
      const iconBox = icon?.getBoundingClientRect();
      return {
        label: node.getAttribute('aria-label') || node.title || node.className,
        width: Math.round(box.width * 100) / 100,
        height: Math.round(box.height * 100) / 100,
        iconWidth: iconBox ? Math.round(iconBox.width * 100) / 100 : null,
        iconHeight: iconBox ? Math.round(iconBox.height * 100) / 100 : null,
        color: icon ? getComputedStyle(icon).color : null,
        active: node.classList.contains('is-active'),
        stroke: icon ? getComputedStyle(icon).strokeWidth : null,
      };
    };
    return {
      tabbar: [...document.querySelectorAll('.panel-tabbar .icon-button')].map(read),
      preview: [...document.querySelectorAll('.file-preview-actions .icon-button')].map(read),
      modePill: (() => {
        const pill = document.querySelector('.file-preview-mode');
        const box = pill.getBoundingClientRect();
        return { width: Math.round(box.width), height: Math.round(box.height) };
      })(),
    };
  });

  const light = await geometry();
  const all = [...light.tabbar, ...light.preview];
  assert.equal(all.length, light.tabbar.length + light.preview.length);
  assert.ok(all.length >= 6, `expected both toolbars to render icon buttons: ${JSON.stringify(light)}`);

  for (const button of all) {
    assert.equal(button.width, 28, `icon button box drifted: ${JSON.stringify(button)}`);
    assert.equal(button.height, 28, `icon button box drifted: ${JSON.stringify(button)}`);
    assert.equal(button.iconWidth, 14, `icon size drifted: ${JSON.stringify(button)}`);
    assert.equal(button.iconHeight, 14, `icon size drifted: ${JSON.stringify(button)}`);
    assert.equal(button.stroke, '1.75px', `stroke drifted: ${JSON.stringify(button)}`);
  }
  // 激活态（分段控件当前项）本来就该不同色，其余图标的静息色必须一致。
  const resting = all.filter(button => !button.active);
  assert.equal(new Set(resting.map(button => button.color)).size, 1, `icon colour drifted: ${JSON.stringify(resting)}`);
  assert.ok(all.some(button => button.active && button.color !== resting[0].color), 'active state must stay visible');
  assert.equal(light.modePill.height, 32, `segmented control height drifted: ${JSON.stringify(light.modePill)}`);

  // 灯箱：工具栏、翻页箭头、计数器与全应用图标同档。
  await page.locator('.conversation-image-tile').first().click();
  await page.locator('.studio-lightbox .yarl__toolbar').waitFor();
  const lightbox = await page.evaluate(() => {
    const read = (node) => {
      const box = node.getBoundingClientRect();
      const icon = node.querySelector('svg');
      const iconBox = icon?.getBoundingClientRect();
      return {
        width: Math.round(box.width * 100) / 100,
        height: Math.round(box.height * 100) / 100,
        iconWidth: iconBox ? Math.round(iconBox.width * 100) / 100 : null,
        stroke: icon ? getComputedStyle(icon).strokeWidth : null,
      };
    };
    const counter = document.querySelector('.studio-lightbox .yarl__counter');
    return {
      toolbarButtons: [...document.querySelectorAll('.studio-lightbox .yarl__toolbar .yarl__button')].map(read),
      nav: ['.yarl__navigation_prev', '.yarl__navigation_next']
        .map((selector) => document.querySelector(`.studio-lightbox ${selector}`))
        .filter(Boolean)
        .map(read),
      counterHeight: counter ? Math.round(counter.getBoundingClientRect().height) : null,
    };
  });
  assert.ok(lightbox.toolbarButtons.length >= 3, `lightbox toolbar buttons: ${JSON.stringify(lightbox)}`);
  for (const button of lightbox.toolbarButtons) {
    assert.equal(button.width, 32, `lightbox button box drifted: ${JSON.stringify(button)}`);
    assert.equal(button.height, 32, `lightbox button box drifted: ${JSON.stringify(button)}`);
    assert.equal(button.iconWidth, 16, `lightbox icon size drifted: ${JSON.stringify(button)}`);
    assert.equal(button.stroke, '1.75px', `lightbox icon stroke drifted: ${JSON.stringify(button)}`);
  }
  for (const nav of lightbox.nav) {
    assert.equal(nav.width, 40, `lightbox nav box drifted: ${JSON.stringify(nav)}`);
    assert.equal(nav.iconWidth, 20, `lightbox nav icon drifted: ${JSON.stringify(nav)}`);
  }
  assert.equal(lightbox.counterHeight, 32, `lightbox counter drifted: ${JSON.stringify(lightbox.counterHeight)}`);
  await page.screenshot({ path: output + 'icon-lightbox-light.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.locator('.studio-lightbox').waitFor({ state: 'detached' });

  await page.screenshot({ path: output + 'icon-consistency-light.png', animations: 'disabled' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: output + 'icon-consistency-dark.png', animations: 'disabled' });

  assert.deepEqual(errors, []);
  console.log('PASS: tab bar and file preview share one icon-button box (28), icon size (14), stroke and colour.');
} finally {
  await browser.close();
}
