const { test } = require('node:test');
const assert = require('node:assert/strict');

const { copyImageToClipboard } = require('../../electron/services/image-clipboard.cjs');

test('copyImageToClipboard writes a supported inline image to the native clipboard', () => {
  const src = 'data:image/png;base64,aGVsbG8=';
  let decoded;
  let written;
  const result = copyImageToClipboard(src, {
    createFromDataURL(value) {
      decoded = value;
      return { isEmpty: () => false };
    },
    writeImage(image) {
      written = image;
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(decoded, src);
  assert.equal(written instanceof Object, true);
});

test('copyImageToClipboard rejects non-inline and undecodable image sources', () => {
  const adapter = {
    createFromDataURL: () => ({ isEmpty: () => true }),
    writeImage: () => assert.fail('empty images must not be written'),
  };

  assert.throws(
    () => copyImageToClipboard('https://example.com/image.png', adapter),
    /不支持的图片数据格式/,
  );
  assert.throws(
    () => copyImageToClipboard('data:image/png;base64,AAAA', adapter),
    /图片数据无法解码/,
  );
});
