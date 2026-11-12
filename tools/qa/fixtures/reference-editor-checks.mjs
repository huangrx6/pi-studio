import assert from 'node:assert/strict';
import { composerValue, selectComposerRange } from './composer-editor.mjs';

/** Real Chromium interaction checks, shared with the existing isolated composer QA. */
export async function checkReferenceEditor(page) {
  const editor = page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true });
  const sample = '请检查 @frontend/ 和 @src/App.tsx，参考 @docs/spec.pdf @data/report.xlsx @package.json @settings.yaml @assets/demo.png @audio/demo.mp3 @video/demo.mp4 @release.zip /skill:skill-creator 后继续。';
  await editor.fill(sample);
  assert.equal(await composerValue(editor), sample);
  assert.deepEqual(await editor.locator('.ref-chip-label').allTextContents(), [
    'frontend', 'App.tsx', 'spec.pdf', 'report.xlsx', 'package.json', 'settings.yaml', 'demo.png', 'demo.mp3', 'demo.mp4', 'release.zip', 'skill-creator',
  ]);
  for (const kind of ['folder', 'code', 'doc', 'sheet', 'image', 'audio', 'video', 'archive', 'skill']) {
    assert(await editor.locator(`.ref-chip.is-${kind} > svg`).count(), `${kind} has an icon`);
  }
  assert.equal(await editor.locator('.ref-chip').first().getAttribute('title'), 'frontend/');
  assert.equal(await editor.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);

  const quoted = '@"docs/API v2 @draft.md"';
  await editor.fill(`${quoted}尾部`);
  await selectComposerRange(editor, quoted.length);
  await editor.press('Backspace');
  assert.equal(await composerValue(editor), '尾部', 'Backspace removes the entire reference');
  await editor.press('ControlOrMeta+z');
  assert.equal(await composerValue(editor), `${quoted}尾部`, 'undo restores raw path and label');
  await editor.press('ControlOrMeta+Shift+z');
  assert.equal(await composerValue(editor), '尾部', 'redo repeats atomic deletion');

  await editor.fill(`前 ${quoted} 后`);
  await selectComposerRange(editor, 2, 2 + quoted.length);
  const copied = await editor.evaluate(node => {
    const clipboard = new DataTransfer();
    node.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard }));
    return clipboard.getData('text/plain');
  });
  assert.equal(copied, quoted, 'copy exports the real path, not the short label');
  await editor.evaluate(node => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', '@README.md');
    clipboard.setData('text/html', '<img src=x onerror=alert(1)>');
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  assert.equal(await composerValue(editor), '前 @README.md 后');
  assert.equal(await editor.locator('img').count(), 0, 'rich clipboard markup is never imported');

  await editor.fill('中文 @src/App.tsx ');
  await selectComposerRange(editor, (await composerValue(editor)).length);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '测试', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '测试' });
  await cdp.detach();
  assert.equal(await composerValue(editor), '中文 @src/App.tsx 测试', 'IME commits beside an existing reference');
  await editor.press('Shift+Enter');
  await editor.pressSequentially('next');
  assert.equal(await composerValue(editor), '中文 @src/App.tsx 测试\nnext');
  assert.equal(await editor.locator('.ref-chip').count(), 1);

  await editor.fill(`@${'long-directory-'.repeat(30)}/README.md @${'long-file-'.repeat(30)}.md`);
  assert.equal(await editor.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'long references cannot overflow the editor');
  assert.equal(await editor.locator('.ref-chip-label').first().textContent(), 'README.md');
  await editor.fill('');
}
