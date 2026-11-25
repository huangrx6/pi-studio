import assert from 'node:assert/strict';
import { composerValue, selectComposerRange } from './composer-editor.mjs';

/** Real Chromium interaction checks, shared with the existing isolated composer QA. */
export async function checkReferenceEditor(page, capture) {
  const editor = page.getByRole('textbox', { name: '发送给 Pi 的消息', exact: true });
  const mixed = '参考 @deepseek-harness/ #[agent:81a1c938-91b8-4a09-9622-ae1b2ec32ef5|indigo-bob|代码审阅] $[skill:cosmic-split|cosmic-split] $[mcp:context7-query-docs|context7%2Fquery-docs] 整理文档。';
  const viewport = page.viewportSize();
  const theme = await page.locator('html').getAttribute('data-theme');
  await page.setViewportSize({ width: 1280, height: viewport.height });
  await editor.fill(mixed);
  await editor.locator('.is-agent img').evaluate(image => image.decode());
  const geometry = await editor.evaluate(root => {
    const center = rect => rect.top + rect.height / 2;
    const range = document.createRange();
    range.selectNodeContents(root.firstChild);
    const textCenter = center(range.getBoundingClientRect());
    return [...root.querySelectorAll('.ref-chip')].map(chip => {
      const box = chip.getBoundingClientRect();
      const icon = chip.firstElementChild.getBoundingClientRect();
      const label = chip.lastElementChild.getBoundingClientRect();
      return { center: center(box), height: box.height, iconSize: icon.height,
        iconOffset: center(icon) - center(box), labelOffset: center(label) - center(box),
        paddingDifference: (icon.left - box.left) - (box.right - label.right), textOffset: center(box) - textCenter };
    });
  });
  assert.equal(geometry.length, 4);
  for (const item of geometry) {
    assert.ok(Math.abs(item.center - geometry[0].center) < 1 && item.height === geometry[0].height, 'four reference kinds share one centerline and height: ' + JSON.stringify(geometry));
    assert.ok(item.iconSize === geometry[0].iconSize && Math.abs(item.iconOffset) < 1 && Math.abs(item.labelOffset) < 1);
    assert.ok(Math.abs(item.paddingDifference) < 1 && Math.abs(item.textOffset) <= 2, 'icon and label stay centered next to prose: ' + JSON.stringify(item));
  }
  for (const mode of ['light', 'dark']) {
    await page.locator('html').evaluate((node, value) => { node.dataset.theme = value; }, mode);
    await capture('references-' + mode, editor);
  }
  await page.locator('html').evaluate((node, value) => {
    if (value === null) node.removeAttribute('data-theme');
    else node.dataset.theme = value;
  }, theme);
  await page.setViewportSize({ width: 720, height: viewport.height });
  await editor.fill(mixed + ' ' + mixed);
  const rows = await editor.locator('.ref-chip').evaluateAll(chips => chips.map(chip => chip.getBoundingClientRect().top));
  assert.ok(rows.at(-1) > rows[0], 'mixed references wrap in a narrow composer');
  assert.ok(await editor.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await page.setViewportSize(viewport);

  const sample = '请检查 @frontend/ 和 @src/App.tsx，参考 @docs/spec.pdf @data/report.xlsx @package.json @settings.yaml @assets/demo.png @audio/demo.mp3 @video/demo.mp4 @release.zip /skill:skill-creator 后继续。';
  await editor.fill(sample);
  assert.equal(await composerValue(editor), sample);
  assert.deepEqual(await editor.locator('.ref-chip-label').allTextContents(), [
    'frontend', 'App.tsx', 'spec.pdf', 'report.xlsx', 'package.json', 'settings.yaml', 'demo.png', 'demo.mp3', 'demo.mp4', 'release.zip', 'skill-creator',
  ]);
  for (const chip of await editor.locator('.ref-chip').all()) {
    assert.equal(await chip.locator(':scope > :is(svg, img[data-file-icon])').count(), 1, await chip.innerText());
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
  assert.equal(await editor.locator('img:not([data-file-icon]), [onerror]').count(), 0, 'rich clipboard markup is never imported');

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
