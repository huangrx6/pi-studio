/**
 * Focused browser QA for icon and toolbar geometry consistency.
 *
 * Proves that the right-panel tab bar and the shared file-preview toolbar use the
 * same icon-button box, the same icon size and the same icon colour, and that the
 * preview/source segmented control uses that same geometry.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node scripts/qa/qa-icon-consistency.mjs
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

  await page.route('**/popover-preview*', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="UTF-8"></head><body style="margin:0;background:var(--bg)"><div id="fixture" class="app"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/styles/app.css');
      await import('/src/shell/right-panel/styles/right-panel.css');
      await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/styles.css');
      await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/captions/captions.css');
      await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/counter/counter.css');
      await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/thumbnails/thumbnails.css');
      const React = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
      const { PanelTabBar } = await import('/src/shell/right-panel/PanelTabBar.tsx');
      const { RightPanelToolList } = await import('/src/shell/right-panel/RightPanelStart.tsx');
      const { FilePreview } = await import('/src/shared/FilePreview.tsx');
      const { AttachmentIcon } = await import('/src/shared/AttachmentIcon.tsx');
      const { ComposerSuggestions } = await import('/src/features/conversation/ComposerSuggestions.tsx');
      const { ConversationImageGallery } = await import('/src/features/conversation/ConversationImageGallery.tsx');
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#192126'; ctx.fillRect(0, 0, 320, 200);
      const shot = canvas.toDataURL('image/png');
      const { MoreHorizontal } = await import('/@fs/${process.cwd()}/node_modules/.vite/deps/lucide-react.js');
      const filePath = new URLSearchParams(location.search).get('file') || 'README.md';
      const name = filePath.split('/').at(-1);
      const tabs = [{ id: 'files', kind: 'files', title: '文件' }, { id: 'file:1', kind: 'file', title: name, path: filePath }];
      const toolActions = [
        { id: 'files', label: '文件', onSelect: () => {} },
        { id: 'terminal', label: '终端', onSelect: () => {} },
      ];
      const file = {
        path: filePath, name,
        size: 72,
        mimeType: 'text/markdown',
        kind: 'text',
        text: '# Pi Studio\\n\\n工作区文件预览。\\n\\n- Markdown 渲染\\n- 源码切换\\n',
      };
      function Fixture() {
        if (new URLSearchParams(location.search).has('file-icons')) {
          return React.createElement('div', { className: 'file-panel' },
            React.createElement(RightPanelToolList, { actions: toolActions }),
            React.createElement('div', { className: 'composer-dock' },
              React.createElement(AttachmentIcon, { name }),
              React.createElement(ComposerSuggestions, { menu: { kind: 'file', query: '' }, commandOptions: [], activeIndex: 0,
                loading: false, error: '', workspace: 'pi-studio', onHover: () => {}, onSelect: () => {}, onRetry: () => {},
                fileOptions: [{ type: 'file', name, path: filePath }, { type: 'directory', name: 'docs', path: 'docs' }] })));
        }
        return React.createElement('div', { className: 'file-panel', style: { width: 'min(520px, 100%)' } },
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
      controlSize: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-sm')),
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
    assert.equal(button.width, lightbox.controlSize, `lightbox button box drifted: ${JSON.stringify(button)}`);
    assert.equal(button.height, lightbox.controlSize, `lightbox button box drifted: ${JSON.stringify(button)}`);
    assert.equal(button.iconWidth, 16, `lightbox icon size drifted: ${JSON.stringify(button)}`);
    assert.equal(button.stroke, '1.75px', `lightbox icon stroke drifted: ${JSON.stringify(button)}`);
  }
  for (const nav of lightbox.nav) {
    assert.equal(nav.width, 40, `lightbox nav box drifted: ${JSON.stringify(nav)}`);
    assert.equal(nav.iconWidth, 20, `lightbox nav icon drifted: ${JSON.stringify(nav)}`);
  }
  assert.equal(lightbox.counterHeight, lightbox.controlSize, `lightbox counter drifted: ${JSON.stringify(lightbox.counterHeight)}`);
  await page.screenshot({ path: output + 'icon-lightbox-light.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.locator('.studio-lightbox').waitFor({ state: 'detached' });

  async function checkFileHeader(directory) {
    const identity = page.locator('.file-preview-identity');
    assert.equal(await identity.locator('.file-preview-directory').innerText(), directory);
    const [icon, name, path, actions] = await Promise.all([
      identity.locator('img'), identity.locator('strong'), identity.locator('.file-preview-directory'), page.locator('.file-preview-actions'),
    ].map(element => element.boundingBox()));
    assert.ok(Math.abs((icon.y + icon.height / 2) - (name.y + name.height / 2)) <= 1);
    assert.ok(icon.x + icon.width <= name.x && name.x + name.width <= actions.x);
    assert.ok(path.y >= name.y + name.height && Math.abs(path.x - icon.x) <= 1);
    const fills = await page.locator('.panel-tab-icon, .panel-tab-icon > *, .file-preview-identity, .file-preview-identity img')
      .evaluateAll(icons => icons.map(icon => getComputedStyle(icon).backgroundColor));
    assert.ok(fills.every(fill => fill === 'rgba(0, 0, 0, 0)'), 'file and folder glyphs have transparent backgrounds');
    const tabColors = await page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => getComputedStyle(tab).backgroundColor));
    assert.notEqual(tabColors[0], tabColors[1], 'selection is still visible across the whole file tab');
  }

  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await checkFileHeader('根目录');
    await page.screenshot({ path: output + 'icon-consistency-' + theme + '.png', animations: 'disabled' });
    const bar = await page.locator('.panel-tabbar').boundingBox();
    const header = await page.locator('.file-preview-toolbar').boundingBox();
    await page.screenshot({ path: output + 'file-header-' + theme + '.png', animations: 'disabled',
      clip: { x: bar.x, y: bar.y, width: bar.width, height: header.y + header.height - bar.y } });
  }
  const directory = '工作区/' + '嵌套目录/'.repeat(10) + '文档';
  const file = directory + '/文件预览时需要显示的完整文件名.md';
  await page.setViewportSize({ width: 340, height: 640 });
  await page.goto('http://127.0.0.1:5180/popover-preview?file=' + encodeURIComponent(file));
  await checkFileHeader(directory);
  assert.ok(await page.locator('.file-preview-directory').evaluate(path => path.scrollWidth > path.clientWidth));
  assert.equal(await page.locator('.file-preview-directory').getAttribute('title'), file);

  await page.goto('http://127.0.0.1:5180/popover-preview?file-icons');
  const reusedIcons = page.locator('.panel-tool-icon, .attachment-icon, .composer-option-icon');
  await reusedIcons.first().waitFor({ state: 'attached' });
  assert.equal(await reusedIcons.count(), 5);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const wallpaper of [false, true]) {
      await page.locator('.app').evaluate((app, enabled) => app.classList.toggle('is-wallpaper-inside', enabled), wallpaper);
      const fills = await reusedIcons.evaluateAll(icons => icons.map(icon => getComputedStyle(icon).backgroundColor));
      assert.ok(fills.every(fill => fill === 'rgba(0, 0, 0, 0)'), 'tool shortcuts, attachment icons and file suggestions have transparent backgrounds');
    }
  }

  assert.deepEqual(errors, []);
  console.log('Passed toolbar geometry, file title and directory alignment, and transparent icons in both themes.');
} finally {
  await browser.close();
}
