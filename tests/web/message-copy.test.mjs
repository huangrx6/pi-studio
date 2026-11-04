import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeClipboardText, messageClipboardHtml } from '../../web/src/features/conversation/message-copy.ts';

const png = 'data:image/png;base64,aGVsbG8=';
const webp = 'data:image/webp;base64,d29ybGQ=';

test('image first, then the escaped text body', () => {
  assert.equal(
    messageClipboardHtml({ text: '看这个报错\n第二行', images: [png] }),
    `<img src="${png}" alt=""><div>看这个报错<br>第二行</div>`,
  );
});

test('multiple images keep their order', () => {
  assert.equal(
    messageClipboardHtml({ text: '两张图', images: [png, webp] }),
    `<img src="${png}" alt=""><img src="${webp}" alt=""><div>两张图</div>`,
  );
});

test('text is escaped so pasted content cannot carry markup', () => {
  assert.equal(escapeClipboardText('<b>&"x"</b>'), '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
  assert.equal(
    messageClipboardHtml({ text: '<script>x</script>', images: [png] }),
    `<img src="${png}" alt=""><div>&lt;script&gt;x&lt;/script&gt;</div>`,
  );
});

test('image-only messages still produce html', () => {
  assert.equal(messageClipboardHtml({ text: '   ', images: [png] }), `<img src="${png}" alt="">`);
});

test('unsupported or unrelated sources fall back to plain text', () => {
  assert.equal(messageClipboardHtml({ text: '只有文字', images: [] }), '');
  assert.equal(messageClipboardHtml({ text: '只有文字', images: ['https://example.com/a.png'] }), '');
  assert.equal(messageClipboardHtml({ text: '只有文字', images: ['data:image/svg+xml;base64,PHN2Zz4='] }), '');
  assert.equal(messageClipboardHtml({ text: '只有文字', images: ['data:image/png;base64,'] }), '');
});
