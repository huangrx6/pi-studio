import assert from 'node:assert/strict';
import test from 'node:test';
import {
  temporaryChatCanSubmit,
  temporaryChatEnterAction,
} from '../../web/src/features/conversation/temporary-chat-input.ts';

const ready = {
  draft: '只在内存里的消息',
  imageCount: 0,
  modelRef: 'provider/model',
  unavailable: false,
  busy: false,
};

test('temporary chat submits only with a usable model and real content', () => {
  assert.equal(temporaryChatCanSubmit(ready), true);
  assert.equal(temporaryChatCanSubmit({ ...ready, draft: '   ', imageCount: 1 }), true);
  assert.equal(temporaryChatCanSubmit({ ...ready, draft: '', imageCount: 0 }), false);
  assert.equal(temporaryChatCanSubmit({ ...ready, modelRef: '' }), false);
  assert.equal(temporaryChatCanSubmit({ ...ready, unavailable: true }), false);
  assert.equal(temporaryChatCanSubmit({ ...ready, busy: true }), false);
});

test('temporary chat Enter keeps IME ownership and Shift+Enter native', () => {
  const enter = { ...ready, key: 'Enter', shiftKey: false, altKey: false, isComposing: false, keyCode: 13 };
  assert.equal(temporaryChatEnterAction(enter), 'send');
  for (const overrides of [
    { isComposing: true },
    { isComposing: false, keyCode: 229 },
    { shiftKey: true },
    { altKey: true },
    { modelRef: '' },
    { unavailable: true },
  ]) assert.equal(temporaryChatEnterAction({ ...enter, ...overrides }), 'none');
  assert.equal(temporaryChatEnterAction({ ...enter, key: 'a' }), 'none');
});
