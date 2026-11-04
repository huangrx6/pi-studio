const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  copyImageToClipboard,
} = require('../../electron/services/image-clipboard.cjs');

function recordingAdapter({ decode } = {}) {
  const items = [];
  const written = [];
  return {
    items,
    written,
    adapter: {
      decode: decode || (() => ({
        isEmpty: () => false,
        toPNG: () => Buffer.from('89504e470d0a1a0a', 'hex'),
      })),
      createItem: (mimeType, buffer) => {
        const item = { mimeType, buffer };
        items.push(item);
        return item;
      },
      write: async (batch) => written.push(...batch),
    },
  };
}

test('copyImageToClipboard 用 ClipboardItem 写入 PNG', async () => {
  const { adapter, items, written } = recordingAdapter();
  const result = await copyImageToClipboard('data:image/png;base64,aGVsbG8=', adapter);

  assert.deepEqual(result, { ok: true });
  assert.equal(items.length, 1);
  assert.equal(items[0].mimeType, 'image/png');
  assert.equal(items[0].buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(written.length, 1);
});

test('copyImageToClipboard 一律以 PNG 交付，不把 webp/svg 原样塞进剪贴板', async () => {
  let decoded;
  const { adapter, items } = recordingAdapter({
    decode: (value) => {
      decoded = value;
      return { isEmpty: () => false, toPNG: () => Buffer.from('png-bytes') };
    },
  });
  await copyImageToClipboard('data:image/webp;base64,d29ybGQ=', adapter);

  assert.equal(decoded, 'data:image/webp;base64,d29ybGQ=');
  assert.equal(items[0].mimeType, 'image/png');
  assert.equal(items[0].buffer.toString(), 'png-bytes');
});

test('copyImageToClipboard 拒绝非内联、无法解码与空图片', async () => {
  const emptyAdapter = recordingAdapter({ decode: () => ({ isEmpty: () => true }) }).adapter;
  await assert.rejects(() => copyImageToClipboard('https://example.com/image.png', emptyAdapter), /不支持的图片数据格式/);
  await assert.rejects(() => copyImageToClipboard('data:image/png;base64,AAAA', emptyAdapter), /图片数据无法解码/);
  await assert.rejects(
    () => copyImageToClipboard('data:image/png;base64,aGVsbG8=', recordingAdapter({ decode: () => { throw new Error('boom'); } }).adapter),
    /图片数据无法解码/,
  );
});

test('主进程不再调用 Electron 45 已删除的剪贴板方法', () => {
  const root = path.join(__dirname, '..', '..', 'electron');
  const offenders = [];
  for (const file of fs.readdirSync(root, { recursive: true })) {
    if (!file.endsWith('.cjs')) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (/clipboard\.(?:writeImage|readImage|availableFormats)\b/.test(source)) offenders.push(file);
    if (/clipboard\.write\(\s*\{/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
