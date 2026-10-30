// Visual regression fixtures use actual components, no user data or model requests.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const output = new URL('../../.qa/screenshots/chat-review/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(10000);
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log(error.message); });
  await page.route('**/popover-preview', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="UTF-8"></head><body style="overflow:auto;height:auto"><div id="fixture"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
    await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/styles.css');
    await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/captions/captions.css');
    await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/counter/counter.css');
    await import('/@fs/${process.cwd()}/node_modules/yet-another-react-lightbox/dist/plugins/thumbnails/thumbnails.css');
    await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/app.css');
    const React = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
    const { AssistantTurnView } = await import('/src/components/ChatMessage.tsx');
    const tools = ['read', 'edit', 'edit', 'write', 'edit', 'edit'];
    const imageColors = ['d6f5e8','dce9ff','fff0cf','f3dcff','ffe1dc','dff2f0','e7e8ff'];
    const images = imageColors.map((color,index) => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520" viewBox="0 0 800 520"><rect width="800" height="520" rx="34" fill="#' + color + '"/><path d="M100 380 290 175l130 142 92-92 188 155" fill="none" stroke="#1c2a24" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/><circle cx="655" cy="130" r="48" fill="#fff" fill-opacity=".72"/><text x="76" y="105" fill="#1c2a24" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="36" font-weight="700">Harness image ' + (index + 1) + '</text></svg>';
      return {type:'image', mimeType:'image/svg+xml', data:btoa(svg)};
    });
    const messages = [{role:'assistant', timestamp:1, content:[
      {type:'thinking',thinking:'先检查组件，再统一布局和字体。'},
      {type:'text',text:'我会调整变更摘要的位置，并简化轨迹图标。'},
      ...tools.map((name,index) => ({type:'toolCall',id:String(index),name,arguments:{path:'src/component-'+index+'.tsx',content:'export const ready = true;'}})),
      {type:'text',text:'## 调整完成\\n\\n正文与标题现在使用同一套字体，通过字号和字重区分层级。\\n\\n文件变更在回答结束后展示，可以展开查看每次修改。'.split('\\n').join(String.fromCharCode(10))},
      ...images,
      {type:'text',text:'图片保持统一盒子尺寸并完整显示；数量过多时使用横向滚动，点击可查看大图。'}
    ]}];
    const screenshotSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560" viewBox="0 0 900 560"><rect width="900" height="560" fill="#eef3f0"/><rect x="50" y="45" width="800" height="470" rx="24" fill="#fff" stroke="#b7c8bf" stroke-width="3"/><path d="M90 110h320M90 155h540M90 200h470" stroke="#769489" stroke-width="16" stroke-linecap="round"/><circle cx="710" cy="340" r="72" fill="#d6f5e8"/><text x="90" y="430" fill="#1c2a24" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="34" font-weight="700">MCP screenshot result</text></svg>';
    const results = new Map(tools.map((name,index) => [String(index),{role:'toolResult',content:[
      {type:'text',text:'Completed'},
      ...(index===1?[{type:'image',mimeType:'image/svg+xml',data:btoa(screenshotSvg)}]:[])
    ],details:name==='edit'?{patch:'--- a/file.ts\\n+++ b/file.ts\\n@@ -1 +1 @@\\n-before\\n+after'.split('\\n').join(String.fromCharCode(10))}:undefined}]));
    let changeBusy;
    window.finish = () => changeBusy(false);
    function Fixture() {
      const [busy,setBusy] = React.useState(true);
      const [review,setReview] = React.useState(null);
      changeBusy = setBusy;
      return React.createElement(React.Fragment, null,
        React.createElement('main', {style:{maxWidth:900,margin:'30px auto',padding:'0 24px'}},
          React.createElement(AssistantTurnView, {
            messages,
            toolResults:results,
            busy,
            showCodeView:true,
            cwd:'/project',
            stepDisplay:'detailed',
            onOpenDiff:(file,turn) => {
              const next = {path:file?.path || '', total:turn.files.length};
              window.openedDiff = next;
              setReview(next);
            }
          })
        ),
        review && React.createElement('section', {className:'qa-diff-review'},
          React.createElement('strong', null, '本轮 ' + review.total + ' 个文件'),
          React.createElement('span', null, review.path || '全部文件')
        )
      );
    }
    createRoot(document.getElementById('fixture')).render(React.createElement(Fixture));
    </script></body></html>` }));
  await page.goto('http://127.0.0.1:5180/popover-preview', { waitUntil: 'domcontentloaded' });
  await page.locator('.assistant-response').first().waitFor();
  assert.equal(await page.locator('.assistant-response').count(), 3, 'prose around tool calls and images stays chronologically visible');
  assert.equal(await page.locator('.file-change-summary').count(), 0, 'no card before the round ends');
  await page.evaluate(() => window.finish());
  const card = page.getByRole('region', { name: '本轮文件变更' }); await card.waitFor();
  assert.equal(await page.locator('.file-change-item').count(), 4);
  const finalResponse = await page.locator('.assistant-response').last().boundingBox();
  assert.ok((await card.boundingBox()).y > finalResponse.y + finalResponse.height, 'file summary follows the final prose segment');
  assert.equal(await card.getByText('src/component-0.tsx', {exact:true}).count(), 0, 'read-only paths excluded');
  const fonts = await page.locator('.assistant-response').filter({ has: page.locator('h2') }).first().locator('.markdown').evaluate(node => [getComputedStyle(node.querySelector('h2')).fontFamily, getComputedStyle(node.querySelector('p')).fontFamily]);
  assert.equal(fonts[0], fonts[1]);
  const standaloneThinking = page.locator('.activity-sequence .activity-thinking').first();
  const thinkingLabelBox = await standaloneThinking.locator('.activity-thinking-label').boundingBox();
  await standaloneThinking.locator('summary').click();
  await page.waitForTimeout(220);
  const thinkingBodyBox = await standaloneThinking.locator('.activity-thinking-body .markdown p').first().boundingBox();
  assert.ok(thinkingLabelBox && thinkingBodyBox && Math.abs(thinkingLabelBox.x - thinkingBodyBox.x) <= 1, 'standalone thinking body aligns with its label');
  await standaloneThinking.locator('summary').click();
  await page.waitForTimeout(220);
  const firstTool = page.locator('.activity-sequence .activity-tool').first();
  const icon = await firstTool.evaluate(node => ({border:getComputedStyle(node).borderWidth,shadow:getComputedStyle(node).boxShadow}));
  assert.equal(icon.border, '0px'); assert.equal(icon.shadow, 'none');
  const historyImages = page.locator('.activity-sequence-images').first();
  assert.equal(await page.locator('.activity-tool-image-count').count(), 1, 'tool summaries identify image-bearing tool results');
  assert.equal(await historyImages.locator('.conversation-image-gallery').count(), 1, 'trace renders one shared screenshot gallery');
  const assistantContentBox = await page.locator('.assistant-turn-main').first().boundingBox();
  const collapsedTileBox = await historyImages.locator('.conversation-image-tile').boundingBox();
  assert.ok(assistantContentBox && collapsedTileBox && Math.abs(assistantContentBox.x - collapsedTileBox.x) <= 1, `expanded screenshot columns align with the assistant content edge (${assistantContentBox?.x} vs ${collapsedTileBox?.x})`);
  const summaryBefore = await firstTool.evaluate(node => ({
    x: node.getBoundingClientRect().x,
    top: node.querySelector(':scope > summary').offsetTop,
  }));
  await firstTool.locator('summary').click();
  await firstTool.locator(':scope:not([open])').waitFor();
  await page.waitForTimeout(220);
  assert.equal(await firstTool.locator('.activity-tool-body').count(), 1, 'tool content remains mounted while collapsed');
  const closedTraceState = await firstTool.evaluate(node => {
    const content = getComputedStyle(node, '::details-content');
    return { open: node.open, blockSize: content.blockSize, opacity: content.opacity };
  });
  assert.equal(closedTraceState.open, false);
  assert.equal(closedTraceState.blockSize, '0px', 'collapsed trace content has zero block size');
  assert.equal(closedTraceState.opacity, '0', 'collapsed trace content is visually hidden');
  assert.equal(await historyImages.locator('.conversation-image-tile').count(), 1, 'collapsed traces keep screenshot thumbnails visible');
  const summaryAfter = await firstTool.evaluate(node => ({
    x: node.getBoundingClientRect().x,
    top: node.querySelector(':scope > summary').offsetTop,
  }));
  const collapsedAfterTileBox = await historyImages.locator('.conversation-image-tile').boundingBox();
  assert.ok(Math.abs(summaryBefore.x - summaryAfter.x) <= .5 && Math.abs(summaryBefore.top - summaryAfter.top) <= .5, 'opening and collapsing does not move the trace header');
  assert.ok(assistantContentBox && collapsedAfterTileBox && Math.abs(assistantContentBox.x - collapsedAfterTileBox.x) <= 1, `collapsed screenshot columns align with the assistant content edge (${assistantContentBox?.x} vs ${collapsedAfterTileBox?.x})`);
  await page.screenshot({path:output+'trajectory-collapsed.png',fullPage:true,animations:'disabled'});
  await firstTool.locator('summary').click();
  await firstTool.locator(':scope[open]').waitFor();
  await page.waitForTimeout(220);
  assert.equal(await historyImages.locator('.conversation-image-gallery').count(), 1, 'screenshot gallery is never duplicated during expansion');
  const detailsTransition = await firstTool.evaluate(node => getComputedStyle(node, '::details-content').transitionDuration);
  assert.notEqual(detailsTransition, '0s', 'trace content uses the shared smooth details transition');
  const firstTraceTool = firstTool;
  const toolIconBefore = await firstTraceTool.evaluate(node => {
    const icon = node.querySelector('.activity-tool-icon').getBoundingClientRect();
    const summary = node.querySelector(':scope > summary').getBoundingClientRect();
    return { viewportX: icon.x, centerOffset: icon.y + icon.height / 2 - summary.y };
  });
  await firstTraceTool.locator('summary').click();
  await page.waitForTimeout(220);
  const toolIconAfter = await firstTraceTool.evaluate(node => {
    const icon = node.querySelector('.activity-tool-icon').getBoundingClientRect();
    const summary = node.querySelector(':scope > summary').getBoundingClientRect();
    return { viewportX: icon.x, centerOffset: icon.y + icon.height / 2 - summary.y };
  });
  assert.ok(Math.abs(toolIconBefore.viewportX - toolIconAfter.viewportX) <= 1.5, `opening a tool row keeps its icon fixed horizontally (${JSON.stringify(toolIconBefore)} vs ${JSON.stringify(toolIconAfter)})`);
  assert.ok(Math.abs(toolIconBefore.centerOffset - toolIconAfter.centerOffset) <= .5, 'opening a tool row keeps its icon vertically centered');
  await firstTraceTool.locator('summary').click();
  await page.waitForTimeout(220);
  const imageStrip = page.locator('.assistant-turn-main > .conversation-image-gallery .conversation-image-strip').first();
  await imageStrip.waitFor();
  assert.equal(await imageStrip.locator('.conversation-image-tile').count(), 7, 'consecutive image blocks render as one gallery');
  const imageLayout = await imageStrip.evaluate(node => ({
    overflowX: getComputedStyle(node).overflowX,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    tiles: [...node.querySelectorAll('.conversation-image-tile')].map(tile => {
      const box = tile.getBoundingClientRect();
      const image = tile.querySelector('img');
      const imageBox = image.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        imageWidth: imageBox.width,
        imageHeight: imageBox.height,
        objectFit: getComputedStyle(image).objectFit,
      };
    }),
  }));
  assert.equal(imageLayout.overflowX, 'auto');
  assert.ok(imageLayout.scrollWidth > imageLayout.clientWidth, 'large galleries scroll horizontally');
  assert.equal(new Set(imageLayout.tiles.map(tile => `${tile.width}x${tile.height}`)).size, 1, 'all image tiles share one size');
  assert.ok(imageLayout.tiles.every(tile => tile.imageWidth <= tile.width && tile.imageHeight <= tile.height));
  assert.ok(imageLayout.tiles.every(tile => tile.objectFit === 'contain'));
  await page.screenshot({path:output+'image-gallery.png',fullPage:true,animations:'disabled'});
  const firstImageTrigger = imageStrip.locator('.conversation-image-tile').first();
  await firstImageTrigger.click();
  const imagePreview = page.getByRole('dialog', {name:'图片预览'});
  await imagePreview.waitFor();
  await page.screenshot({path:output+'image-preview.png',animations:'disabled'});
  for (const label of ['下载图片', '进入全屏', '放大', '缩小', '隐藏缩略图', '关闭图片预览']) {
    assert.equal(await imagePreview.getByRole('button', {name:label}).count(), 1, `lightbox exposes ${label}`);
  }
  const thumbnailNavigation = imagePreview.getByRole('navigation', {name:'图片缩略图'});
  const renderedThumbnailCount = await thumbnailNavigation.locator('.yarl__thumbnails_thumbnail').count();
  assert.ok(renderedThumbnailCount >= 3 && renderedThumbnailCount <= 7, `lightbox renders a navigable window of thumbnails (${renderedThumbnailCount})`);
  assert.equal(await imagePreview.getByText('第 1 张，共 7 张', {exact:true}).count(), 1, 'lightbox shows the localized caption');
  await imagePreview.getByRole('button', {name:'放大'}).click();
  await page.waitForTimeout(260);
  const zoomTransform = await imagePreview.locator('.yarl__slide_current .yarl__slide_wrapper').evaluate(node => getComputedStyle(node).transform);
  assert.notEqual(zoomTransform, 'none', 'lightbox zoom control transforms the active image');
  await imagePreview.getByRole('button', {name:'缩小'}).click();
  await page.waitForTimeout(260);
  assert.equal(
    await imagePreview.locator('.yarl__slide_current .yarl__slide_wrapper').evaluate(node => getComputedStyle(node).transform),
    'matrix(1, 0, 0, 1, 0, 0)',
    'zoom out restores the active image to its fitted size',
  );
  await imagePreview.getByRole('button', {name:'隐藏缩略图'}).click();
  assert.equal(await thumbnailNavigation.isVisible(), false, 'thumbnail navigator can be collapsed');
  await imagePreview.getByRole('button', {name:'显示缩略图'}).click();
  await thumbnailNavigation.waitFor();
  await imagePreview.locator('.yarl__container').press('ArrowRight');
  await page.waitForTimeout(260);
  assert.equal(await page.getByText('2 / 7', {exact:true}).count(), 1);
  await page.keyboard.press('Escape');
  await imagePreview.waitFor({state:'detached'});
  assert.equal(await firstImageTrigger.evaluate(node => document.activeElement === node), true, 'closing the lightbox restores focus to the trigger');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await imageStrip.locator('.conversation-image-tile').nth(1).click();
  await page.getByRole('dialog', {name:'图片预览'}).waitFor();
  await page.screenshot({path:output+'image-preview-dark.png',animations:'disabled'});
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.screenshot({path:output+'light.png',fullPage:true,animations:'disabled'});
  await page.evaluate(() => {
    const fixture = document.getElementById('fixture');
    fixture.classList.add('app','has-custom-background');
    fixture.style.cssText = 'display:block;height:auto;overflow:visible';
  });
  const openTool = await firstTool.evaluate(node => {
    const body = node.querySelector('.activity-tool-body');
    const code = node.querySelector('.activity-tool-code');
    const toolStyle = getComputedStyle(node);
    const bodyStyle = getComputedStyle(body);
    const codeStyle = getComputedStyle(code);
    return {
      open: node.open,
      border: parseFloat(toolStyle.borderTopWidth),
      radius: parseFloat(toolStyle.borderTopLeftRadius),
      bodyBackground: bodyStyle.backgroundColor,
      codePadding: parseFloat(codeStyle.paddingLeft),
      codeRadius: parseFloat(codeStyle.borderTopLeftRadius),
      codeBorder: parseFloat(codeStyle.borderTopWidth),
    };
  });
  assert.equal(openTool.open, true);
  assert.equal(openTool.border, 0, 'execution rows use the shared borderless disclosure style');
  assert.ok(openTool.radius >= 8, 'expanded tool keeps its shared corner radius');
  assert.equal(openTool.bodyBackground, 'rgba(0, 0, 0, 0)', 'tool body does not add an opaque rectangular layer');
  assert.ok(openTool.codePadding >= 12, 'expanded tool parameters have breathing room');
  assert.ok(openTool.codeRadius >= 8, 'parameter surface follows the shared corner radius');
  assert.ok(openTool.codeBorder >= 1, 'parameter surface has a readable inset border');
  await page.screenshot({path:output+'custom-background-tool-open.png',fullPage:true,animations:'disabled'});
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({path:output+'custom-background-tool-open-dark.png',fullPage:true,animations:'disabled'});
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await firstTool.locator('summary').click();
  await page.getByRole('button',{name:'全部 5 个文件'}).click();
  assert.equal(await page.locator('.file-change-item').count(),5);
  await page.getByRole('button',{name:'查看变更',exact:true}).click();
  await page.locator('.qa-diff-review').waitFor();
  assert.deepEqual(await page.evaluate(() => window.openedDiff), { path: '', total: 5 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({path:output+'dark-review.png',fullPage:true,animations:'disabled'});
  assert.deepEqual(errors, []);
  console.log('PASS: completed-round placement, successful mutations only, file expansion, diff review, unified fonts, lightweight timeline, horizontal image gallery and expanded custom-background tool card.');
} finally { await browser.close(); }
