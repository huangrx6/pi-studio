const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_BASE64_CHARS,
  MAX_SIDE,
  fitMessages,
  imageSize,
  inspectImage,
} = require('../../electron/capabilities/image-fit/fit.cjs');

/** 只带签名与 IHDR 的 PNG 头，够图片尺寸解析用。 */
function pngOf(width, height) {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer.toString('base64');
}

function gifOf(width, height) {
  const buffer = Buffer.alloc(13);
  buffer.write('GIF89a', 0, 'latin1');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer.toString('base64');
}

function webpOf(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(22, 4);
  buffer.write('WEBP', 8, 'latin1');
  buffer.write('VP8X', 12, 'latin1');
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer.toString('base64');
}

function jpegOf(width, height) {
  const buffer = Buffer.alloc(4 + 4 + 13);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xe0;
  buffer.writeUInt16BE(4, 4);
  buffer.write('JFIF', 6, 'latin1');
  buffer[10] = 0xff;
  buffer[11] = 0xc0;
  buffer.writeUInt16BE(11, 12);
  buffer[14] = 8;
  buffer.writeUInt16BE(height, 15);
  buffer.writeUInt16BE(width, 17);
  return buffer.toString('base64');
}

const userMessage = (content) => ({ role: 'user', content, timestamp: 1 });

test('imageSize 从常见图片头读出像素尺寸', () => {
  assert.deepEqual(imageSize(pngOf(1976, 10663), 'image/png'), { width: 1976, height: 10663 });
  assert.deepEqual(imageSize(gifOf(640, 480), 'image/gif'), { width: 640, height: 480 });
  assert.deepEqual(imageSize(webpOf(3024, 1964), 'image/webp'), { width: 3024, height: 1964 });
  assert.deepEqual(imageSize(jpegOf(1600, 900), 'image/jpeg'), { width: 1600, height: 900 });
  assert.equal(imageSize('bm90IGFuIGltYWdl', 'image/png'), null);
});

test('inspectImage 区分正常、超长、超大与不支持的格式', () => {
  assert.equal(inspectImage({ type: 'image', mimeType: 'image/png', data: pngOf(1000, 639) }).ok, true);

  const tooLong = inspectImage({ type: 'image', mimeType: 'image/png', data: pngOf(MAX_SIDE + 1, 640) });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.reason, 'too-long');

  const tooLarge = inspectImage({ type: 'image', mimeType: 'image/png', data: 'A'.repeat(MAX_BASE64_CHARS + 4) });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.reason, 'too-large');

  const unsupported = inspectImage({ type: 'image', mimeType: 'image/tiff', data: pngOf(10, 10) });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.reason, 'unsupported');

  const unreadable = inspectImage({ type: 'image', mimeType: 'image/png', data: 'bm90IGFuIGltYWdl' });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.reason, 'unreadable');
});

test('没有超限图片时不改写请求，也不调用编码器', () => {
  const messages = [userMessage([{ type: 'text', text: '看这张图' }, { type: 'image', mimeType: 'image/png', data: pngOf(1000, 639) }])];
  const result = fitMessages(messages, {
    codec: { refit: () => assert.fail('正常图片不应触发缩放') },
  });

  assert.equal(result.changed, false);
  assert.equal(result.messages, messages);
  assert.deepEqual(result.applied, []);
});

test('超长图片按单边上限重新编码，并保留未改动消息的对象身份', () => {
  const tall = { type: 'image', mimeType: 'image/png', data: pngOf(1976, 10663) };
  const untouched = userMessage([{ type: 'text', text: '上一轮' }]);
  const changedMessage = userMessage([{ type: 'text', text: '看这张长截图' }, tall]);
  let received;
  const result = fitMessages([untouched, changedMessage], {
    codec: {
      refit(input) {
        received = input;
        return { data: 'Zml0dGVk', mimeType: 'image/png', width: 1482, height: 8000 };
      },
    },
  });

  assert.equal(result.changed, true);
  assert.equal(received.maxSide, MAX_SIDE);
  assert.equal(received.maxBase64Chars, MAX_BASE64_CHARS);
  assert.equal(received.data, tall.data);
  assert.equal(result.messages[0], untouched);
  assert.notEqual(result.messages[1], changedMessage);
  assert.deepEqual(result.messages[1].content[0], { type: 'text', text: '看这张长截图' });
  assert.deepEqual(result.messages[1].content[1], { type: 'image', data: 'Zml0dGVk', mimeType: 'image/png' });
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].reason, 'too-long');
  assert.equal(result.applied[0].height, 10663);
});

test('长图可以被拆成多段发送，顺序和数量都保留', () => {
  const result = fitMessages([userMessage([{ type: 'image', mimeType: 'image/png', data: pngOf(1976, 10663) }])], {
    codec: {
      refit: () => [
        { data: 'c2xpY2UtMQ==', mimeType: 'image/png' },
        { data: 'c2xpY2UtMg==', mimeType: 'image/png' },
        { data: 'c2xpY2UtMw==', mimeType: 'image/png' },
      ],
    },
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.messages[0].content.map((block) => block.data), [
    'c2xpY2UtMQ==',
    'c2xpY2UtMg==',
    'c2xpY2UtMw==',
  ]);
  assert.equal(result.applied[0].slices, 3);
});

test('编码器只要有一段不合格，就整组放弃', () => {
  const messages = [userMessage([{ type: 'image', mimeType: 'image/png', data: pngOf(1976, 10663) }])];
  const result = fitMessages(messages, {
    codec: {
      refit: () => [
        { data: 'c2xpY2UtMQ==', mimeType: 'image/png' },
        { data: '', mimeType: 'image/png' },
      ],
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.messages, messages);
});

test('不支持的格式转码失败时省略图片并留下说明，避免会话被卡死', () => {
  const result = fitMessages([userMessage([{ type: 'image', mimeType: 'image/tiff', data: 'AAAA' }])], {
    codec: { refit: () => null },
  });

  assert.equal(result.changed, true);
  assert.equal(result.messages[0].content[0].type, 'text');
  assert.match(result.messages[0].content[0].text, /image\/tiff/);
});

test('改后缀的“图片”转码失败时同样省略，不再让请求硬失败', () => {
  const result = fitMessages([userMessage([{ type: 'text', text: '看图' }, { type: 'image', mimeType: 'image/png', data: 'bm90IGFuIGltYWdl' }])], {
    codec: { refit: () => null },
  });

  assert.equal(result.changed, true);
  assert.equal(result.applied[0].reason, 'unreadable');
  assert.match(result.messages[0].content[1].text, /数据无法识别/);
});

test('编码器抛错时保持原样，不计为改动', () => {
  const messages = [userMessage([{ type: 'image', mimeType: 'image/png', data: pngOf(1976, 10663) }])];
  const result = fitMessages(messages, {
    codec: { refit: () => { throw new Error('decode failed'); } },
  });

  assert.equal(result.changed, false);
  assert.equal(result.messages, messages);
});

test('同一张图片只缩放一次，后续请求复用缓存', () => {
  const cache = new Map();
  const messages = [userMessage([{ type: 'image', mimeType: 'image/png', data: pngOf(1976, 10663) }])];
  let calls = 0;
  const codec = {
    refit() {
      calls += 1;
      return { data: 'Zml0dGVk', mimeType: 'image/png' };
    },
  };

  const first = fitMessages(messages, { codec, cache });
  const second = fitMessages(messages, { codec, cache });

  assert.equal(calls, 1);
  assert.equal(first.changed, true);
  assert.deepEqual(second.messages, first.messages);
  assert.equal(second.applied[0].cached, true);
});
