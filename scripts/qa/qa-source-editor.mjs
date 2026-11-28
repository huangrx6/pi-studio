import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { configureTestModel, launchTestDesktop, selectTestSession } from './fixtures/isolated-desktop.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, '.qa', 'source-editor');
const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-studio-source-')));
const cwd = path.join(scratch, 'workspace'), profile = path.join(scratch, 'profile');
const caller = 'sdk/cli/pi-studio-extension.mjs', definition = 'electron/main/core/extension-package.cjs';
const symbol = 'validateExtensionDirectory';
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
let app, page;
try {
  await Promise.all([mkdir(output, {recursive:true}), mkdir(profile), ...[caller, definition].map(async file => {
    const destination = path.join(cwd,file);
    await mkdir(path.dirname(destination),{recursive:true}); await copyFile(path.join(root,file),destination);
  })]);
  await writeFile(path.join(cwd,'README.md'),'# Atlas Notes\n\nDocument preview.\n');
  await writeFile(path.join(cwd,'PLAN.md'),'# Atlas Plan\n\nReview the changes.\n');
  await writeFile(path.join(cwd,'matching.md'),'# Live preview\n\nShared edit');
  await writeFile(path.join(cwd,'scroll-sample.py'),Array.from({length:160}, (_, index) =>
    'row_' + (index + 1) + ' = "' + 'a long line of code '.repeat(20) + '"').join('\n'));
  await copyFile(path.join(root,'package.json'), path.join(cwd,'package.json'));
  const source = await readFile(path.join(cwd, caller), 'utf8');
  const callLine = source.split('\n').findIndex(line => line.includes('return ' + symbol + '(')) + 1;
  const targetSource = await readFile(path.join(cwd, definition), 'utf8');
  const targetLine = targetSource.split('\n').findIndex(line => line.startsWith('function ' + symbol + '(')) + 1;
  ({app,page} = await launchTestDesktop(cwd,profile,1700,1000));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await configureTestModel(page,cwd,'http://127.0.0.1:1/v1');
  const id = await page.evaluate(async cwd => (await window.piApi.createConversation({cwd,title:'源码导航'})).id,cwd);
  await page.evaluate(() => localStorage.setItem('pi-studio:preferences',JSON.stringify({theme:'dark'})));
  await page.reload(); await selectTestSession(page,cwd,id);
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('monaco-runtime'))),false);
  const button = (root,name) => root.getByRole('button',{name,exact:true});
  const tree = name => page.getByRole('treeitem',{name,exact:true});
  const menu = name => page.getByRole('menuitem',{name,exact:true});
  const left = page.locator('.content-region > .session-document');
  const right = page.getByRole('region',{name:'右侧编辑器组'});
  const leftTabs = page.getByRole('tablist',{name:'工作树标签'});
  async function clickSymbol(panel,options) {
    const row = panel.locator('.view-line').filter({hasText:symbol}).first();
    await row.waitFor();
    const point = await row.evaluate((line,word) => {
      const walker = document.createTreeWalker(line,NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode, index = node.textContent.indexOf(word);
        if (index < 0) continue;
        const range = document.createRange(); range.setStart(node,index + 2); range.setEnd(node,index + 3);
        const glyph = range.getBoundingClientRect(), bounds = line.getBoundingClientRect();
        return { x: glyph.x + glyph.width / 2 - bounds.x, y: glyph.y + glyph.height / 2 - bounds.y };
      }
    },symbol);
    assert.ok(point,'the symbol is rendered as editable source text');
    await row.click({ position: point, modifiers: options?.modified ? [modifier] : [] });
    if (!options?.modified) await panel.locator('.monaco-editor textarea:focus').waitFor({ state: 'attached' });
  }
  await button(page,'打开右侧面板').click();
  await tree('package.json').click();
  async function checkJsonColors(pane) {
    await pane.locator('.view-line').filter({hasText:'"name"'}).first().waitFor();
    await page.waitForFunction(node => new Set(Array.from(node.querySelectorAll('.view-line span[class^="mtk"]'), span => getComputedStyle(span).color)).size >= 4, await pane.elementHandle());
  }
  await checkJsonColors(left);
  const more = button(left,'文件操作');
  assert.deepEqual(await left.locator('.file-preview-actions button').allTextContents(), ['预览','源码','编辑','分栏','']);
  await more.click();
  const fileMenu = page.getByRole('menu', {name:'文件操作'});
  await fileMenu.waitFor();
  const bounds = await fileMenu.boundingBox();
  const trigger = await more.boundingBox();
  assert.ok(Math.abs(bounds.x + bounds.width - trigger.x - trigger.width) <= 1);
  const labelOffsets = await fileMenu.locator('button > span').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().left));
  assert.equal(new Set(labelOffsets).size, 1, 'file commands share one leading edge');
  const header = await left.locator('.file-preview-toolbar').boundingBox();
  const clip = {x:header.x,y:header.y,width:header.width,height:bounds.y+bounds.height-header.y+18};
  await page.mouse.move(10,10);
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; },theme);
    await page.screenshot({path:path.join(output,'file-menu-'+theme+'.png'),clip,animations:'disabled',scale:'css'});
  }
  await page.keyboard.press('Escape');
  await button(left,'在右侧打开').click();
  await button(right,'查看文件源码').click();
  await button(right,'编辑文件').click();
  await checkJsonColors(right);
  const inputs = right.locator('.file-preview-actions');
  assert.deepEqual(await inputs.locator('button').allTextContents(), ['预览','源码','保存','取消','']);
  assert.ok(await inputs.evaluate(node => node.getBoundingClientRect().right <= node.closest('.file-preview-pane').getBoundingClientRect().right));
  await button(right,'取消编辑').click();
  await button(right,'关闭 package.json').click();
  await tree('scroll-sample.py').click();
  await button(left,'在右侧打开').click();
  await right.locator('.view-line').first().waitFor();
  async function assertAlignedSplit() {
    for (const selector of ['.file-preview-toolbar', '.file-preview-body']) {
      const a = await left.locator(selector).boundingBox(), b = await right.locator(selector).boundingBox();
      assert.ok(Math.abs(a.y - b.y) <= 1 && a.x + a.width <= b.x + 1, selector + ' is aligned across the split');
    }
    const a = await leftTabs.getByRole('tab',{selected:true}).boundingBox();
    const b = await right.getByRole('tab',{selected:true}).boundingBox();
    assert.ok(Math.abs(a.y - b.y) <= 1, 'both tab strips occupy the window title bar');
  }
  await assertAlignedSplit();
  await button(page,'收起右侧面板').click();
  await assertAlignedSplit();
  const scrollable = left.locator('.editor-scrollable');
  const horizontal = scrollable.locator(':scope > .scrollbar.horizontal');
  const thumb = horizontal.locator('.slider');
  await scrollable.hover();
  const trackBox = await horizontal.boundingBox(), thumbBox = await thumb.boundingBox();
  assert.equal(trackBox.height,10);
  assert.equal(thumbBox.height,4);
  assert.ok(await thumb.evaluate(node => parseFloat(getComputedStyle(node).borderRadius) >= 2));
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; },theme);
    await page.waitForFunction(node => {
      const style = document.createElement('span').style;
      style.color = getComputedStyle(document.documentElement).getPropertyValue('--scrollbar').trim();
      return getComputedStyle(node).backgroundColor === style.color;
    }, await thumb.elementHandle());
  }
  assert.ok(await scrollable.locator(':scope > .scrollbar.vertical').evaluate(node => !node.getBoundingClientRect().width));
  await page.mouse.move(thumbBox.x + thumbBox.width / 2,thumbBox.y + thumbBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumbBox.x + thumbBox.width / 2 + 60,thumbBox.y + thumbBox.height / 2,{steps:6});
  await page.mouse.up();
  assert.ok(await thumb.evaluate(node => parseFloat(node.style.left) > 0),'dragging the thin thumb scrolls horizontally');
  await page.mouse.move(trackBox.x + 35,trackBox.y - 48);
  await page.mouse.wheel(0,600);
  await page.waitForFunction(node => Number(/row_(\d+)/.exec(node.querySelector('.view-line')?.textContent ?? '')?.[1]) > 2, await scrollable.elementHandle());
  await right.locator('.view-line').filter({hasText:/^row_1\s/}).waitFor();
  await page.screenshot({path:path.join(output,'split-scroll.png'),animations:'disabled',scale:'css'});
  await left.getByRole('textbox',{name:/scroll-sample.py 源码编辑器/}).focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await left.locator('.view-line').filter({hasText:/^row_160\s/}).waitFor();
  const zoom = await app.evaluate(({BrowserWindow}) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents, original = contents.getZoomFactor();
    contents.setZoomFactor(2);
    return original;
  });
  await page.waitForFunction(() => matchMedia('(max-width: 900px)').matches);
  const upper = await left.boundingBox(), lowerTabs = await right.getByRole('tablist').boundingBox();
  assert.ok(lowerTabs.y >= upper.y + upper.height - 1, 'narrow layouts place the lower tab strip between documents');
  await app.evaluate(({BrowserWindow},zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom),zoom);
  await page.waitForFunction(() => matchMedia('(min-width: 901px)').matches);
  await button(right,'关闭 scroll-sample.py').click();
  await button(page,'打开右侧面板').click();
  await tree('README.md').click(); await left.getByRole('heading',{name:'Atlas Notes'}).waitFor();
  await tree('sdk').click(); await tree('cli').click(); await tree('pi-studio-extension.mjs').click();
  await left.locator('.monaco-editor .view-line').first().waitFor();
  assert.equal(await leftTabs.getByRole('tab',{name:'README.md'}).count(),1,'a single click keeps the preceding document');
  await clickSymbol(left);
  await page.keyboard.press('Shift+ArrowRight');
  const editor = await left.locator('.monaco-editor').elementHandle();
  await left.locator('.selected-text').first().waitFor();
  await button(left,'编辑文件').click();
  assert.ok(await editor.evaluate(node => node.isConnected), 'editing retains the mounted source view');
  await left.locator('.selected-text').first().waitFor();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  await page.keyboard.press('ArrowDown'); await page.keyboard.insertText('// 未保存的编辑');
  await left.locator('.view-line').filter({hasText:'未保存的编辑'}).waitFor();
  assert.ok(await left.locator('.view-lines span[class^="mtk"]').evaluateAll(nodes => new Set(nodes.map(n=>getComputedStyle(n).color)).size >= 4));
  await clickSymbol(left); await page.keyboard.press(modifier+'+F12');
  await right.locator('.file-preview-identity strong').filter({hasText:'extension-package.cjs'}).waitFor();
  await right.locator('.view-line').filter({hasText:'function'}).filter({hasText:symbol}).first().waitFor();
  await page.waitForFunction(strip => {
    const selected = strip.querySelector('[aria-selected=true]').closest('.document-tab').getBoundingClientRect();
    const bounds = strip.getBoundingClientRect();
    return selected.left >= bounds.left - 1 && selected.right <= bounds.right + 1;
  }, await leftTabs.elementHandle());
  async function checkFunctionColor() {
    await page.waitForFunction(symbol => {
      const planned = document.createElement('span').style;
      planned.color = getComputedStyle(document.documentElement).getPropertyValue('--editor-function').trim();
      const spans = document.querySelectorAll('.session-side-group .view-line span[class^="mtk"]');
      return Array.from(spans).some(span => span.textContent === symbol && getComputedStyle(span).color === planned.color);
    }, symbol);
  }
  await checkFunctionColor();
  await left.locator('.view-line').filter({hasText:'未保存的编辑'}).waitFor();
  await button(page,'收起右侧面板').click();
  await button(right,'返回上一位置').click();
  await page.keyboard.press('Shift+F12');
  const references = left.locator('.source-locations');
  await references.getByRole('button',{name:new RegExp('pi-studio-extension.mjs.*' + callLine + ':')}).click();
  const activeLine = (panel, line) => panel.locator('.active-line-number').filter({hasText:new RegExp('^' + line + '$')});
  await activeLine(left,callLine).waitFor();
  await page.keyboard.press(modifier+'+F12');
  await activeLine(right,targetLine).waitFor();
  await checkFunctionColor();
  await page.mouse.move(10, 10);
  await page.screenshot({path:path.join(output,'definition-dark.png'),animations:'disabled',scale:'css'});
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await checkFunctionColor();
  await page.screenshot({path:path.join(output,'definition-light.png'),animations:'disabled',scale:'css'});
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await button(right,'返回上一位置').click();
  await activeLine(left,callLine).waitFor();
  await clickSymbol(left,{modified:true});
  await left.locator('.file-preview-identity strong').filter({hasText:'extension-package.cjs'}).waitFor();
  await button(left,'返回上一位置').click();
  await activeLine(left,callLine).waitFor();
  await leftTabs.locator('.document-dirty').waitFor();
  await page.keyboard.press('F12');
  await left.locator('.file-preview-identity strong').filter({hasText:'extension-package.cjs'}).waitFor();
  await page.keyboard.press(process.platform === 'darwin' ? 'Control+-' : 'Alt+ArrowLeft');
  await activeLine(left,callLine).waitFor();
  await button(left,'取消编辑').click();
  assert.ok(!(await readFile(path.join(cwd,caller),'utf8')).includes('未保存的编辑'));
  await leftTabs.getByRole('tab',{name:'README.md'}).click();
  await button(left,'编辑文件').click();
  await button(left,'在右侧打开').click();
  await right.getByRole('heading',{name:'Atlas Notes'}).waitFor();
  await left.locator('.view-line').first().click();
  await page.keyboard.press(modifier+'+A'); await page.keyboard.insertText('# Live preview');
  await right.getByRole('heading',{name:'Live preview'}).waitFor();
  await button(right,'查看文件源码').click();
  await button(right,'编辑文件').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.insertText('\n\nShared edit');
  await left.locator('.view-line').filter({hasText:'Shared edit'}).waitFor();
  const leftInput = left.getByRole('textbox',{name:/README.md 源码编辑器/});
  await leftInput.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  await activeLine(left,1).waitFor();
  await activeLine(right,3).waitFor();
  await page.keyboard.press(modifier+'+Z');
  await right.locator('.view-line').filter({hasText:'Shared edit'}).waitFor({state:'detached'});
  await right.getByRole('textbox',{name:/README.md 源码编辑器/}).focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+Y');
  await left.locator('.view-line').filter({hasText:'Shared edit'}).waitFor();
  await button(right,'预览渲染结果').click();
  await right.getByRole('heading',{name:'Live preview'}).waitFor();
  const picker = page.getByRole('dialog',{name:'选择比较文件'});
  const search = picker.getByRole('searchbox',{name:'搜索比较文件'});
  await button(right,'文件操作').click(); await menu('与文件比较…').click();
  await picker.waitFor();
  assert.ok(await search.evaluate(input => input === document.activeElement));
  await picker.getByText('原文件 · README.md',{exact:true}).waitFor();
  assert.equal(await picker.getByRole('treeitem',{name:'README.md',exact:true}).count(),0);
  await page.keyboard.press('Escape');
  await picker.waitFor({state:'detached'});
  assert.equal(await leftTabs.getByRole('tab',{name:/↔/}).count(),0);
  await leftTabs.getByRole('tab',{name:'README.md',exact:true}).click({button:'right'});
  await menu('与文件比较…').click();
  await picker.getByRole('button',{name:'package.json',exact:true}).click();
  await left.locator('.source-compare-title').getByText('package.json',{exact:true}).waitFor();
  await leftTabs.getByRole('tab', { name: 'README.md ↔ package.json', exact: true }).press('Shift+F10');
  await menu('关闭此标签页').click();
  await button(right,'文件操作').click(); await menu('与文件比较…').click();
  await search.fill('matching');
  await picker.getByRole('button',{name:'matching.md',exact:true}).waitFor();
  await search.press('Enter');
  await left.getByText('两份文件内容相同',{exact:true}).waitFor();
  await left.locator('.monaco-diff-editor').waitFor();
  assert.notEqual(await readFile(path.join(cwd,'README.md'),'utf8'),await readFile(path.join(cwd,'matching.md'),'utf8'),
    'the comparison uses the shared unsaved text');
  await button(leftTabs,'关闭 README.md ↔ matching.md').click();
  await leftTabs.getByRole('tab',{name:'README.md',exact:true}).click();
  await leftInput.focus();
  await page.keyboard.press(modifier+'+S');
  await button(left,'编辑文件').waitFor();
  assert.equal(await readFile(path.join(cwd,'README.md'),'utf8'),'# Live preview\n\nShared edit');
  await button(page,'打开右侧面板').click();
  await tree('README.md').click({button:'right'}); await menu('与文件比较…').click();
  await picker.getByRole('treeitem',{name:'PLAN.md',exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'comparison-picker.png'),animations:'disabled',scale:'css'});
  await picker.getByRole('treeitem',{name:'PLAN.md',exact:true}).click();
  await left.locator('.monaco-diff-editor .line-insert').first().waitFor();
  assert.ok(await left.locator('.monaco-diff-editor .editor-scrollable > .scrollbar.vertical')
    .evaluateAll(nodes => nodes.length === 2 && nodes.every(node => !node.getBoundingClientRect().width)));
  await page.screenshot({path:path.join(output,'comparison.png'),animations:'disabled'});
  await page.reload();
  await left.locator('.monaco-diff-editor').waitFor(); await right.getByRole('heading',{name:'Live preview'}).waitFor();
  while (await right.count()) {
    await right.locator('.document-tab:has([aria-selected=true]) .tab-close').click();
  }
  await page.reload();
  await left.locator('.monaco-diff-editor .line-insert').first().waitFor();
  assert.ok((await left.locator('.studio-monaco-host').boundingBox()).height > 200, 'a restored standalone diff fills the canvas');
  assert.deepEqual(errors,[]);
  console.log('Passed real Electron editing and navigation, split header alignment, scrolling, file comparison from toolbar, tab and tree, drafts, and layout restoration.');
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
    console.error((await page.locator('body').innerText()).slice(-2500));
  }
  throw error;
} finally {
  await app?.close(); await rm(scratch,{recursive:true,force:true});
}
