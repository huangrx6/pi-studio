/**
 * Focused browser QA for icon and toolbar geometry consistency.
 *
 * Checks session tabs, file preview actions, file icons and the image viewer.
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
      await import('/src/shell/styles/session-inspection.css');
      await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/styles.css');
      await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/captions/captions.css');
      await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/counter/counter.css');
      await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/thumbnails/thumbnails.css');
      const React = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
      const { SessionContentTabs } = await import('/src/shell/SessionContent.tsx');
      const { FilePreview } = await import('/src/shared/FilePreview.tsx');
      const { AttachmentIcon } = await import('/src/shared/AttachmentIcon.tsx');
      const { ComposerSuggestions } = await import('/src/features/conversation/ComposerSuggestions.tsx');
      const { ConversationImageGallery } = await import('/src/features/conversation/ConversationImageGallery.tsx');
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#192126'; ctx.fillRect(0, 0, 320, 200);
      const shot = canvas.toDataURL('image/png');
      const filePath = new URLSearchParams(location.search).get('file') || 'README.md';
      const name = filePath.split('/').at(-1);
      const tabs = [{ id: 'file:1', kind: 'file', title: name, path: filePath }];
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
            React.createElement('div', { className: 'composer-dock' },
              React.createElement(AttachmentIcon, { name }),
              React.createElement(ComposerSuggestions, { menu: { kind: 'file', query: '' }, commandOptions: [], activeIndex: 0,
                loading: false, error: '', workspace: 'pi-studio', onHover: () => {}, onSelect: () => {}, onRetry: () => {},
                onOpenMethods() {}, onBack() {}, onCategory() {}, mentionOptions: [{ type: 'file', name, path: filePath }, { type: 'directory', name: 'docs', path: 'docs' }] })));
        }
        return React.createElement('div', { className: 'file-panel', style: { width: 'min(520px, 100%)' } },
          React.createElement(SessionContentTabs, { onClose() {}, controller: {
            layout: { tabs, active: 'file:1' }, owner: 'session:demo', filesOpen: true,
            activate() {}, pin() {}, reorder() {}, fileActions() { return []; },
          }}),
          React.createElement(FilePreview, {
            file,
            onOpenExternal: () => {},
            editable: true, onSplit() {},
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
  await page.locator('.session-content-tabs .tab-close').first().waitFor();

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
      tabbar: [...document.querySelectorAll('.session-content-tabs .tab-close')].map(read),
      preview: [...document.querySelectorAll('.file-preview-actions .icon-button')].map(read),
      modes: [...document.querySelectorAll('.file-preview-mode button')].map(button => ({
        text: button.textContent, height: button.offsetHeight, color: getComputedStyle(button).color,
        underline: getComputedStyle(button, '::after').height,
      })),
    };
  });

  const light = await geometry();
  const all = light.preview;
  assert.equal(light.tabbar.length, 1);
  assert.deepEqual(all.map(button => button.label), ['文件操作']);

  for (const button of all) {
    assert.equal(button.width, 28, `icon button box drifted: ${JSON.stringify(button)}`);
    assert.equal(button.height, 28, `icon button box drifted: ${JSON.stringify(button)}`);
    assert.equal(button.iconWidth, 13, `icon size drifted: ${JSON.stringify(button)}`);
    assert.equal(button.iconHeight, 13, `icon size drifted: ${JSON.stringify(button)}`);
    assert.equal(button.stroke, '1.75px', `stroke drifted: ${JSON.stringify(button)}`);
  }
  assert.deepEqual(light.modes.map(mode => mode.text), ['预览', '源码']);
  assert.ok(light.modes.every(mode => mode.height >= 28));
  assert.equal(light.modes[0].underline, '2px');
  assert.notEqual(light.modes[0].color, light.modes[1].color);

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
    assert.equal(button.iconWidth, 15, `lightbox icon size drifted: ${JSON.stringify(button)}`);
    assert.equal(button.stroke, '1.75px', `lightbox icon stroke drifted: ${JSON.stringify(button)}`);
  }
  for (const nav of lightbox.nav) {
    assert.equal(nav.width, 40, `lightbox nav box drifted: ${JSON.stringify(nav)}`);
    assert.equal(nav.iconWidth, 19, `lightbox nav icon drifted: ${JSON.stringify(nav)}`);
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
    assert.ok(icon.x + icon.width <= name.x, JSON.stringify({icon,name}));
    assert.ok(name.x + name.width <= actions.x || path.y + path.height <= actions.y, JSON.stringify({name,path,actions}));
    assert.ok(path.y >= name.y + name.height && Math.abs(path.x - icon.x) <= 1);
    const fills = await page.locator('.file-preview-identity, .file-preview-identity img')
      .evaluateAll(icons => icons.map(icon => getComputedStyle(icon).backgroundColor));
    assert.ok(fills.every(fill => fill === 'rgba(0, 0, 0, 0)'), 'file and folder glyphs have transparent backgrounds');
    const tabColors = await page.getByRole('tab').evaluateAll(tabs =>
      tabs.map(tab => getComputedStyle(tab.closest('.document-tab') || tab).backgroundColor));
    assert.notEqual(tabColors[0], tabColors[1], 'selection is still visible across the whole file tab');
  }

  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await checkFileHeader('根目录');
    await page.screenshot({ path: output + 'icon-consistency-' + theme + '.png', animations: 'disabled' });
    const bar = await page.locator('.session-content-tabs').boundingBox();
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
  const reusedIcons = page.locator('.attachment-icon, .composer-option-icon');
  await reusedIcons.first().waitFor({ state: 'attached' });
  assert.equal(await reusedIcons.count(), 3);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const wallpaper of [false, true]) {
      await page.locator('.app').evaluate((app, enabled) => app.classList.toggle('is-wallpaper-inside', enabled), wallpaper);
      const fills = await reusedIcons.evaluateAll(icons => icons.map(icon => getComputedStyle(icon).backgroundColor));
      assert.ok(fills.every(fill => fill === 'rgba(0, 0, 0, 0)'), 'attachment icons and file suggestions have transparent backgrounds');
    }
  }

  assert.deepEqual(errors, []);
  console.log('Passed toolbar geometry, file title and directory alignment, and transparent icons in both themes.');
} finally {
  await browser.close();
}
