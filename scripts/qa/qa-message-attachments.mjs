import { copyPreviewText } from './fixtures/source-editor.mjs';
// Exercise the built renderer with real images and Studio-managed files in an isolated profile.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composerValue, selectComposerRange } from './fixtures/composer-editor.mjs';
import { configureTestModel, launchTestDesktop, selectTestSession } from './fixtures/isolated-desktop.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, '.qa', 'message-attachments');
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-studio-attachments-')));
const workspace = path.join(temporary, '界面原型');
const fileName = '对话与工作双模式 UI.html';
const filePath = path.join(workspace, fileName);
const imagePaths = ['conversation-light', 'harness-light', 'home-light'].map(name => path.join(root, 'website/assets/screens', name + '.png'));
const html = '<!doctype html>\n<html lang="zh-CN">\n<title>对话与工作双模式</title>\n<h1>工作区原型</h1>\n</html>';
const userText = [
  '我想参考这三张图，做一个桌面端的对话与工作界面。',
  '第一张是对话，第二张是工作区，第三张是首页。请先看一下整体布局。',
  '交互细节放在附带的 HTML 原型里。',
  '我希望对话流能留出足够的阅读空间。',
  '输入区和工作区的样式也要保持一致。',
].join('\n\n');
const text = value => ({ type: 'text', text: value });
let app, page;

async function assertCards(rail, selector, count) {
  const cards = rail.locator(selector);
  await cards.nth(count - 1).waitFor({ state: 'attached' });
  const boxes = await cards.evaluateAll(nodes => nodes.map(node => {
    const { top, height } = node.getBoundingClientRect();
    return { top, height };
  }));
  assert.equal(boxes.length, count);
  assert.ok(boxes[0].height > 0);
  for (const box of boxes) {
    assert.ok(Math.abs(box.top - boxes[0].top) < 1, 'cards share one row');
    assert.ok(Math.abs(box.height - boxes[0].height) < 1, 'images and files share a card height');
  }
  return boxes[0].height;
}

async function assertExternal(rail, surface) {
  const visible = await rail.boundingBox();
  const below = await surface.boundingBox();
  assert.ok(visible && below && visible.y + visible.height <= below.y + 1, 'attachments sit above the text surface');
}

async function assertScrollable(rail) {
  await rail.scrollIntoViewIfNeeded();
  assert.ok(await rail.evaluate(node => node.scrollWidth > node.clientWidth + 4), 'attachments overflow the rail');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'viewport fits the document');
  await rail.evaluate(node => node.scrollTo({ left: 0, behavior: 'instant' }));
  await rail.hover();
  await page.mouse.wheel(240, 0);
  await page.waitForFunction(node => node.scrollLeft > 0, await rail.elementHandle());
}

async function assertImageNavigation(rail) {
  await rail.getByRole('button', { name: /^放大预览图片 1(?:：|$)/ }).click();
  const active = page.locator('.yarl__slide_current .yarl__slide_image');
  await active.waitFor();
  const original = await active.getAttribute('src');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(previous => {
    const current = document.querySelector('.yarl__slide_current .yarl__slide_image');
    return current && current.getAttribute('src') !== previous;
  }, original);
  await page.keyboard.press('Escape');
  await page.locator('.yarl__root').waitFor({ state: 'detached' });
}

async function assertFileOpens(rail) {
  const file = rail.getByRole('button', { name: '打开附件 ' + fileName, exact: true });
  await file.focus();
  await page.keyboard.press('Enter');
  await page.frameLocator('.session-document iframe').getByRole('heading', { name: '工作区原型' }).waitFor();
  await page.getByRole('button', { name: '关闭 ' + fileName, exact: true }).click();
}

async function capture(locator, name) {
  await locator.first().scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  const clip = await locator.evaluateAll(nodes => {
    const boxes = nodes.map(node => node.getBoundingClientRect());
    const x = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.left))) - 16);
    const y = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.top))) - 12);
    const right = Math.ceil(Math.max(...boxes.map(box => box.right))) + 16;
    const bottom = Math.ceil(Math.max(...boxes.map(box => box.bottom))) + 12;
    return { x, y, width: Math.min(innerWidth, right) - x, height: Math.min(innerHeight, bottom) - y };
  });
  await page.screenshot({ path: path.join(output, name), clip, animations: 'disabled', scale: 'css' });
}

try {
  await Promise.all([mkdir(output, { recursive: true }), mkdir(workspace)]);
  await writeFile(filePath, html);
  ({ app, page } = await launchTestDesktop(workspace, path.join(temporary, 'studio'), 1360, 850,
    { extraArgs: ['--proxy-server=http://127.0.0.1:9'] }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await configureTestModel(page, workspace, 'http://127.0.0.1:9/v1');
  const session = await page.evaluate(async cwd => {
    await window.piApi.addCustomModel({ cwd, providerId: 'desktop-qa', modelId: 'check', name: '验收模型', supportsImages: true });
    return window.piApi.createConversation({ cwd, title: '对话与工作界面' });
  }, workspace);
  const base = await page.evaluate(id => window.piApi.conversationPage({ id }), session.id);
  const attachment = await page.evaluate(payload => window.piApi.saveUpload(payload), {
    sessionId: session.id, name: fileName, mime: 'text/html', data: Buffer.from(html).toString('base64'),
  });
  const images = await app.evaluate(({ nativeImage }, paths) => paths.map(file => ({
    type: 'image', mimeType: 'image/png', data: nativeImage.createFromPath(file).resize({ width: 480 }).toPNG().toString('base64'),
  })), imagePaths);
  let index = 0;
  const started = Date.now() - 90_000;
  const message = (role, content, attachments) => ({
    role, content, attachments, sourceIndex: ++index, timestamp: started + index * 1000,
  });
  const messages = [
    message('user', [], [attachment]),
    message('assistant', [text('收到界面原型。')]),
    message('user', [text('这些是补充参考图。'), ...images, ...images, ...images], [attachment]),
    message('assistant', [text('我会结合这些截图核对布局。')]),
    message('user', [text(userText), ...images], [attachment]),
  ];
  await app.evaluate(({ ipcMain, dialog }, { snapshot, id, filePaths }) => {
    ipcMain.removeHandler('pi:conversation-page');
    ipcMain.handle('pi:conversation-page', (_event, request) => {
      if (request.id !== id) throw new Error('Unexpected conversation in isolated fixture');
      return snapshot;
    });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, { snapshot: { ...base, messages, messageStart: 1, messageCount: messages.length }, id: session.id,
    filePaths: [imagePaths[0], filePath, ...imagePaths.slice(1), ...['models', 'extensions', 'usage', 'subagents']
      .map(name => path.join(root, 'website/assets/screens', name + '-light.png'))] });
  await page.evaluate(() => localStorage.setItem('pi-studio:preferences', JSON.stringify({ theme: 'dark' })));
  await page.reload();
  await selectTestSession(page, workspace, session.id);

  const turns = page.locator('.message.user');
  const pure = turns.first();
  const crowdedRail = turns.nth(1).locator('.user-attachments');
  const mixed = turns.last();
  const sentRail = mixed.locator('.user-attachments');
  await mixed.getByText(/我想参考这三张图/).waitFor();
  assert.equal(await pure.locator('.user-attachments').count(), 1);
  assert.equal(await pure.locator('.user-bubble').count(), 0, 'attachment-only message has no empty bubble');
  const sentHeight = await assertCards(sentRail, '.conversation-image-tile, .attachment-card', 4);
  const bubble = mixed.locator('.user-bubble');
  await assertExternal(sentRail, bubble);
  await mixed.scrollIntoViewIfNeeded();
  await sentRail.locator('img').evaluateAll(imgs => Promise.all(imgs.map(img => img.decode())));
  const disclosure = bubble.getByRole('button', { name: '展开更多' });
  await disclosure.waitFor();
  await capture(mixed.locator('.user-attachments, .user-bubble'), 'sent.png');
  await disclosure.click();
  await assertExternal(sentRail, bubble);
  await bubble.getByRole('button', { name: '收起' }).click();
  await assertImageNavigation(sentRail);
  await assertFileOpens(sentRail);
  await mixed.hover();
  await mixed.getByRole('button', { name: '编辑消息' }).click();
  await assertExternal(sentRail, mixed.getByRole('textbox', { name: '编辑消息' }));
  await mixed.getByRole('button', { name: '取消' }).click();

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 780));
  await assertScrollable(crowdedRail);
  await page.getByRole('button', { name: '添加图片或文件', exact: true }).click();
  const draft = page.locator('.composer-wrap');
  const draftRail = draft.locator('.composer-attachments');
  const editor = draft.locator('.composer');
  assert.equal(await assertCards(draftRail, '.composer-attachment', 8), sentHeight);
  await assertExternal(draftRail, editor);
  await assertScrollable(draftRail);
  await editor.locator('[contenteditable="true"]').fill('把这些参考图和界面原型放在一起看。');
  await draftRail.evaluate(node => node.scrollTo({ left: 0, behavior: 'instant' }));
  await capture(draft, 'draft.png');
  await assertImageNavigation(draftRail);
  await assertFileOpens(draftRail);
  await draftRail.getByRole('button', { name: '移除 ' + fileName, exact: true }).click();
  assert.equal(await draftRail.locator('.composer-attachment').count(), 7);
  const typed = '已有草稿';
  const pasted = 'P'.repeat(12_000);
  const textbox = editor.getByRole('textbox', { name: '发送给 Pi 的消息' });
  await textbox.fill(typed);
  await selectComposerRange(textbox, typed.length);
  await textbox.evaluate((node, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, pasted);
  const savedPaste = draftRail.getByRole('button', { name: /打开附件 long-message-.*\.txt/ });
  await savedPaste.press('Enter');
  assert.equal(await copyPreviewText(page.locator('.session-document')), pasted);
  await page.getByRole('tablist', {name:'工作树标签'}).getByRole('tab').first().click();
  assert.equal(await composerValue(textbox), typed);
  assert.deepEqual(errors, []);
  console.log('Attachment checks passed: external rails, alignment, horizontal scrolling, disclosure, editing, previews, keyboard file open and removal.');
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }).catch(() => {});
  throw error;
} finally {
  await app?.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
