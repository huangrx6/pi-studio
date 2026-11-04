const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_HTML_CHARS,
  MAX_TEXT_CHARS,
  copyTextAndHtml,
} = require('../../electron/services/rich-clipboard.cjs');

const image = 'data:image/png;base64,aGVsbG8=';

function recordingAdapter() {
  const written = [];
  return {
    written,
    adapter: {
      createItem: (data) => ({ data }),
      write: async (items) => written.push(...items),
    },
  };
}

test('copyTextAndHtml 同时写入正文与内联图片', async () => {
  const { written, adapter } = recordingAdapter();
  const html = `<img src="${image}" alt=""><div>看这个报错<br>第二行</div>`;

  assert.deepEqual(await copyTextAndHtml({ text: '看这个报错\n第二行', html }, adapter), { ok: true });
  assert.equal(written.length, 1);
  assert.deepEqual(written[0].data, {
    'text/plain': '看这个报错\n第二行',
    'text/html': html,
  });
});

test('copyTextAndHtml 接受只有图片没有正文的复制', async () => {
  const { written, adapter } = recordingAdapter();
  assert.deepEqual(await copyTextAndHtml({ text: '', html: `<img src="${image}" alt="">` }, adapter), { ok: true });
  assert.equal(written[0].data['text/plain'], '');
});

test('copyTextAndHtml 拒绝非内联图片与任意 HTML', async () => {
  const { written, adapter } = recordingAdapter();
  const reject = (html) => assert.rejects(() => copyTextAndHtml({ text: 'x', html }, adapter), /不支持的富文本格式/);

  await reject('<div><img src="https://example.com/a.png"></div>');
  await reject('<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="">');
  await reject('<script>alert(1)</script>');
  await reject('<div onclick="alert(1)">x</div>');
  assert.equal(written.length, 0);
});

test('copyTextAndHtml 限制空的、过大的内容', async () => {
  const { adapter } = recordingAdapter();
  const write = (payload) => copyTextAndHtml(payload, adapter);
  await assert.rejects(() => write({ text: 'x', html: '' }), /没有可复制的富文本内容/);
  await assert.rejects(
    () => write({ text: 'A'.repeat(MAX_TEXT_CHARS + 1), html: `<img src="${image}" alt="">` }),
    /消息文本过长/,
  );
  const huge = `<img src="data:image/png;base64,${'A'.repeat(MAX_HTML_CHARS)}" alt="">`;
  await assert.rejects(() => write({ text: 'x', html: huge }), /图片过大/);
});
