import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import {
  Harness,
  MemoryStorage,
  createRegistry,
} from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@earendil-works/pi-ai';

const require = createRequire(import.meta.url);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-image-fit-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const { closeStudioDatabase } = require('../../electron/core/studio-db.cjs');
const { createStudioImageFitExtension } = require('../../electron/capabilities/image-fit/index.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

/** 只带签名和 IHDR 的 PNG 头，尺寸解析够用。 */
function oversizedPng(width, height) {
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

function imageBlocks(messages) {
  return messages.flatMap((message) => (
    Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'image')
      : []
  ));
}

test('超限长图在真实 Durable 请求里被切成多段，历史保持原样', async () => {
  const durable = await import('@earendil-works/pi-durable');
  const original = oversizedPng(1976, 10663);
  const calls = [];
  const codec = {
    refit(input) {
      calls.push(input);
      return [
        { data: 'c2xpY2UtMQ==', mimeType: 'image/png' },
        { data: 'c2xpY2UtMg==', mimeType: 'image/png' },
      ];
    },
  };
  const imageFit = createStudioImageFitExtension(durable, { codec });

  const beforeRequests = [];
  const afterRequests = [];
  const recorder = (name, sink) => durable.defineExtension({
    name,
    hooks: [durable.hook(durable.GenerationTask, {
      beforeRequest(request) {
        sink.push(request.messages);
        return undefined;
      },
    })],
  });
  const beforeProbe = recorder('probe-before-image-fit', beforeRequests);
  const afterProbe = recorder('probe-after-image-fit', afterRequests);

  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-image', name: 'Image probe' }],
  });
  faux.setResponses([
    () => fauxAssistantMessage('first answer'),
    () => fauxAssistantMessage('second answer'),
  ]);

  const registry = createRegistry();
  registry.install(beforeProbe);
  registry.install(imageFit);
  registry.install(afterProbe);
  const models = createModels();
  models.setProvider(faux.provider);

  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    BACKGROUND_CONTEXT,
  );
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'faux', modelId: 'faux-image' },
        extensions: [beforeProbe, imageFit, afterProbe],
        instructions: 'STUDIO_IMAGE_FIT_SYSTEM',
      },
    });

    const first = await conversation.submit({
      type: 'input',
      content: [
        { type: 'text', text: '看这张长截图' },
        { type: 'image', mimeType: 'image/png', data: original },
      ],
    }, BACKGROUND_CONTEXT);
    assert.equal((await first.wait(BACKGROUND_CONTEXT)).status, 'done');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].data, original);
    assert.equal(calls[0].maxSide, 8000);
    assert.equal(calls[0].mimeType, 'image/png');

    assert.equal(beforeRequests.length, 1);
    assert.deepEqual(
      imageBlocks(beforeRequests[0]).map((block) => block.data),
      [original],
    );
    assert.deepEqual(
      imageBlocks(afterRequests[0]).map((block) => block.data),
      ['c2xpY2UtMQ==', 'c2xpY2UtMg=='],
    );

    const second = await conversation.submit({ type: 'input', content: '第二轮' }, BACKGROUND_CONTEXT);
    assert.equal((await second.wait(BACKGROUND_CONTEXT)).status, 'done');

    // 历史里仍是原图（第二次请求的入参没变），只是每次发出前被适配。
    assert.equal(calls.length, 1);
    assert.deepEqual(
      imageBlocks(beforeRequests[1]).map((block) => block.data),
      [original],
    );
    assert.deepEqual(
      imageBlocks(afterRequests[1]).map((block) => block.data),
      ['c2xpY2UtMQ==', 'c2xpY2UtMg=='],
    );
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
