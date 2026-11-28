import { replaceSourceText, visibleSourceText } from './fixtures/source-editor.mjs';
// Run against the built Electron renderer. All conversation and workspace data are disposable.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureTestModel, launchTestDesktop, selectTestSession } from './fixtures/isolated-desktop.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, '.qa', 'chat-progress');
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-studio-chat-progress-')));
const workspace = path.join(temporary, 'desktop-workbench');
const sourceFile = 'composer.css';
const text = value => ({ type: 'text', text: value });
const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
let sequence = 0;
const started = Date.now() - 60_000;
const message = (role, content, extra = {}) => ({
  role, content, sourceIndex: ++sequence, timestamp: started + sequence * 160, ...extra,
});
const result = (id, name, content, error = false) =>
  message('toolResult', content, { toolCallId: id, toolName: name, isError: error });
const messages = [
  message('user', [text('你好。')]),
  message('assistant', [text('你好，有什么可以帮你的？')]),
  message('user', [text('窗口变窄时，发送按钮会被挤出去。帮我修一下。')]),
];
const finding = '在 360px 宽的窗口复现了。输入框的最小宽度挤占了发送按钮的位置。';
const revision = '360px 已通过。缩到 320px 时，按钮仍有 8px 超出边界，我会再调整一次间距。';

let app, page;
try {
  await Promise.all([mkdir(workspace), mkdir(out, { recursive: true })]);
  await writeFile(path.join(workspace, sourceFile), [
    '.composer-row {', '  display: flex;', '  align-items: center;', '  gap: 12px;', '}',
    '', '.composer-input {', '  flex: 1;', '  min-width: 280px;', '}',
    '', '.composer-send {', '  flex: none;', '}', '',
  ].join('\n'));
  ({ app, page } = await launchTestDesktop(workspace, path.join(temporary, 'studio'), 1380, 810,
    { extraArgs: ['--proxy-server=http://127.0.0.1:9'] }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await configureTestModel(page, workspace, 'http://127.0.0.1:9/v1');
  const session = await page.evaluate(cwd => window.piApi.createConversation({ cwd, title: '修复窄窗口下的发送按钮' }), workspace);
  const { basePage, state } = await page.evaluate(async ({ id, cwd }) => ({
    basePage: await window.piApi.conversationPage({ id }), state: await window.piApi.state(cwd),
  }), session);
  await app.evaluate(({ ipcMain, BrowserWindow }, { sample, state, id }) => {
    // The renderer requests fresh history and live state when returning to chat.
    const summary = state.workspaces.flatMap(item => item.sessions).find(item => item.id === id);
    ipcMain.removeHandler('pi:state');
    ipcMain.handle('pi:state', () => state);
    for (const channel of ['pi:conversation-page', 'pi:conversation-snapshot', 'pi:conversation-subscribe']) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, request) => {
        if ((request.id ?? request) !== id) throw new Error('Unexpected conversation in isolated fixture');
        return sample;
      });
    }
    ipcMain.on('qa:progress-event', event => {
      const { type, payload } = event;
      const window = BrowserWindow.getAllWindows()[0];
      if (type === 'run.started' || type === 'run.completed') {
        sample.running = summary.running = payload.running;
        summary.updatedAt = sample.updatedAt = Date.now();
        window.webContents.send('pi:conversation-list-changed');
      }
      if (type === 'assistant.completed') sample.messages.push(payload.message);
      if (type === 'transcript.appended') sample.messages.push(...payload.messages);
      sample.messageCount = sample.messages.length;
      window.webContents.send('pi:conversation-event', event);
    });
  }, { sample: { ...basePage, messages, messageStart: 1, messageCount: messages.length }, state, id: session.id });
  await page.evaluate(() => localStorage.setItem('pi-studio:preferences', JSON.stringify({ theme: 'dark' })));
  await page.reload();
  await selectTestSession(page, workspace, session.id);
  const header = page.locator('.chat-header');
  await page.getByText('你好，有什么可以帮你的？', { exact: true }).waitFor();
  assert.equal(await page.locator('.assistant-turn').first().locator('.narrative-stream').count(), 0, 'small talk has no execution record');
  assert.equal(await header.getByRole('button', { name: '执行流', exact: true }).count(), 0);
  await page.getByRole('button', { name: '打开右侧面板', expanded: false, exact: true }).click();
  const files = page.getByRole('navigation', { name: '工作区视图' });
  assert.equal(await files.getByRole('button', { name: '文件', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.locator('.file-row').filter({ hasText: sourceFile }).click();
  const tabs = page.getByRole('tablist', { name: '工作树标签' });
  const chatTab = tabs.getByRole('tab', { name: '修复窄窗口下的发送按钮', exact: true });
  const fileTab = tabs.getByRole('tab', { name: sourceFile, exact: true });
  const preview = page.locator('.session-document .file-preview-pane');
  const editor = preview.getByRole('textbox', { name: sourceFile + ' 源码编辑器' });
  await preview.getByText(/min-width/).first().waitFor();
  const assertTabs = async selected => {
    assert.deepEqual(await tabs.getByRole('tab').allTextContents(), ['修复窄窗口下的发送按钮', sourceFile]);
    assert.equal(await selected.getAttribute('aria-selected'), 'true');
  };
  await assertTabs(fileTab);
  await chatTab.click();

  const send = (type, payload) => app.evaluate(({ ipcMain }, event) => {
    ipcMain.emit('qa:progress-event', event);
  }, { conversationId: session.id, type, payload });
  const assistant = content => send('assistant.completed', { message: message('assistant', content) });
  const append = (...items) => send('transcript.appended', { messages: items });
  await send('run.started', { inputs: [], running: true });
  await assistant([text('我先按窄窗口的尺寸复现，再检查输入栏的布局。'), call('read-css', 'read', { path: sourceFile })]);
  const live = page.locator('.assistant-turn.is-live').last();
  const steps = live.locator('.narrative-step-trigger');
  const firstRead = live.locator('.narrative-step.is-read').filter({ hasText: sourceFile });
  await firstRead.waitFor();
  await assertTabs(chatTab);
  const sameRead = await firstRead.elementHandle();
  await append(result('read-css', 'read', [text('min-width: 280px;')]));
  const args = { path: sourceFile, oldText: 'min-width: 280px', newText: 'min-width: 0' };
  const editing = message('assistant', [text(finding), call('edit-css', 'edit', args)]);
  await send('assistant.updated', { message: { ...editing, content: [text('在 360px 宽的窗口复现了。')] } });
  await live.getByText('在 360px 宽的窗口复现了。', { exact: true }).waitFor();
  await send('assistant.completed', { message: editing });
  await live.getByText(finding, { exact: true }).waitFor();
  await live.locator('.narrative-step.is-edit').filter({ hasText: sourceFile }).waitFor();
  assert(await firstRead.evaluate((node, prior) => node === prior, sameRead), 'updates preserve the preceding live step');
  await assertTabs(chatTab);
  await page.mouse.move(2, 2);
  await live.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'live-desktop.png'), animations: 'disabled', scale: 'css' });
  await live.screenshot({ path: path.join(out, 'live-turn.png'), animations: 'disabled', scale: 'css' });
  await fileTab.click();
  await preview.getByRole('button', { name: '编辑文件', exact: true }).click();
  const draft = '/* 尚未保存的备注 */';
  await replaceSourceText(editor, draft);
  await append(result('edit-css', 'edit', [text('已修改 composer.css。')]));
  const relatedFiles = Array.from({ length: 14 }, (_, index) => call('component-' + index, 'read', { path: 'components/input-' + index + '.tsx' }));
  await assistant(relatedFiles);
  await assertTabs(fileTab);
  assert(await editor.evaluate(node => node === document.activeElement), 'a background tool call preserves editor focus');
  await chatTab.click();
  await steps.filter({ hasText: 'input-13.tsx' }).waitFor();
  await append(...relatedFiles.map(({ id }) => result(id, 'read', [text('输入框布局定义。')])));

  const command = 'pnpm test --filter narrow-composer';
  await assistant([call('test-narrow', 'bash', { command })]);
  await steps.filter({ hasText: 'narrow-composer' }).waitFor();
  await append(result('test-narrow', 'bash', [text('320px 下超出边界 8px。')], true));
  await send('retry.updated', { active: true, attempt: 1, errorMessage: '暂时无法连接模型。' });
  await live.getByRole('status').filter({ hasText: /重试/ }).waitFor();
  await fileTab.click();
  assert.equal(await visibleSourceText(preview), draft, 'switching between document and chat restores the edit');
  await editor.focus();
  await send('retry.updated', { active: false, attempt: 1 });
  await assistant([text(revision), call('fix-gap', 'edit', { ...args, oldText: 'gap: 12px', newText: 'gap: 4px' })]);
  await assertTabs(fileTab);
  assert(await editor.evaluate(node => node === document.activeElement), 'streaming and retries preserve the active editor focus');
  assert.equal(await visibleSourceText(preview), draft);
  await chatTab.click();
  await live.getByText(revision, { exact: true }).waitFor();
  await live.locator('.narrative-step.is-edit').filter({ hasText: sourceFile }).last().waitFor();
  await append(result('fix-gap', 'edit', [text('已收紧间距。')]));
  await assistant([call('verify', 'browser_screenshot', { name: '320px 布局检查' })]);
  const [shot, illustration] = await app.evaluate(({ nativeImage }, files) => files.map(file => ({
    type: 'image', mimeType: 'image/png', data: nativeImage.createFromPath(file).resize({ width: 320 }).toPNG().toString('base64'),
  })), ['conversation-dark.png', 'workbench-dark.png'].map(file => path.join(root, 'website/assets/screens', file)));
  await append(result('verify', 'browser_screenshot', [shot]));
  await assistant([call('illustration', 'generate_image', { prompt: '画出修复后的窄屏布局。' })]);
  await steps.filter({ hasText: /图片|generate_image/ }).last().waitFor();
  assert.equal(await live.locator('.conversation-image-tile').count(), 0, 'verification screenshots stay in their tool records');
  await append(result('illustration', 'generate_image', [illustration]));
  const liveImage = live.locator('.assistant-turn-main > .conversation-image-gallery img');
  await liveImage.waitFor();
  assert.equal(await liveImage.getAttribute('src'), 'data:image/png;base64,' + illustration.data);
  await assistant([text('修好了。360px 和 320px 下的按钮都完整可见。')]);
  await send('run.completed', { inputs: [], running: false });
  await live.waitFor({ state: 'detached' });
  const turn = page.locator('.assistant-turn').last();
  const summaries = turn.locator('.narrative-group-trigger');
  await summaries.first().waitFor();
  for (const summary of await summaries.all()) {
    assert.equal(await summary.getAttribute('aria-expanded'), 'false');
    await summary.click();
  }
  const records = turn.locator('.narrative-step-trigger');
  await records.filter({ hasText: 'input-13.tsx' }).waitFor();
  assert.equal(await records.filter({ hasText: /input-\d+\.tsx/ }).count(), 14);
  assert.equal(await turn.locator('.conversation-image-tile').count(), 1, 'opening execution history keeps one generated image');
  const recordedImage = turn.getByRole('button', { name: '放大查看截图 1' });
  assert.equal(await recordedImage.locator('img').getAttribute('src'), 'data:image/png;base64,' + shot.data);
  await recordedImage.click();
  await page.locator('.yarl__slide_image').first().waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.yarl__root').waitFor({ state: 'detached' });
  await records.filter({ hasText: 'narrow-composer' }).click();
  await turn.getByText('320px 下超出边界 8px。', { exact: true }).first().waitFor();
  assert.equal(await turn.locator('.activity-tool-code.is-error').count(), 1);
  await assertTabs(chatTab);
  await fileTab.click();
  assert.equal(await visibleSourceText(preview), draft, 'completed runs and history inspection preserve the document draft');
  await preview.getByRole('button', { name: '取消编辑', exact: true }).click();
  await preview.getByText(/min-width/).first().waitFor();
  assert.deepEqual(errors, []);
  console.log('Chat progress passed: live action, streamed findings, retries, history, errors, image preview and preserved document tabs and edits.');
} catch (error) {
  await page?.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {});
  if (page && !page.isClosed()) console.error((await page.locator('body').innerText()).slice(-1800));
  throw error;
} finally {
  await app?.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
