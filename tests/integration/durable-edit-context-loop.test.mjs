import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('an edit marker removes the old branch from the next model request', async () => {
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-edit', name: 'Edit probe' }],
  });
  let replacementRequest;
  faux.setResponses([
    () => fauxAssistantMessage('OLD_ANSWER_ONE'),
    () => fauxAssistantMessage('OLD_ANSWER_TWO'),
    (context) => {
      replacementRequest = context.messages;
      return fauxAssistantMessage('REPLACEMENT_ANSWER');
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: 'faux-edit' } },
    });
    const first = await conversation.submit({
      type: 'input',
      content: 'OLD_QUESTION_ONE',
    }, BACKGROUND_CONTEXT);
    assert.equal((await first.wait(BACKGROUND_CONTEXT)).status, 'done');
    const second = await conversation.submit({
      type: 'input',
      content: 'OLD_QUESTION_TWO',
    }, BACKGROUND_CONTEXT);
    assert.equal((await second.wait(BACKGROUND_CONTEXT)).status, 'done');

    const context = await conversation.context(BACKGROUND_CONTEXT);
    const targetIndex = context.entries.findIndex((entry) => (
      entry.kind === 'pi.user'
      && entry.model?.some((message) => (
        message.role === 'user'
        && JSON.stringify(message.content).includes('OLD_QUESTION_ONE')
      ))
    ));
    assert.ok(targetIndex >= 0);
    const target = context.entries[targetIndex];
    const marker = await conversation.submit({
      type: 'write',
      entry: {
        kind: 'studio.edit',
        data: { editFrom: Number(target.id), editToken: 'test-edit' },
        edits: context.entries
          .slice(targetIndex)
          .map((entry) => ({ target: Number(entry.id), action: 'omit' })),
      },
    }, BACKGROUND_CONTEXT);
    assert.equal((await marker.status(BACKGROUND_CONTEXT)).status, 'done');

    const replacement = await conversation.submit({
      type: 'input',
      content: 'REPLACEMENT_QUESTION',
    }, BACKGROUND_CONTEXT);
    assert.equal((await replacement.wait(BACKGROUND_CONTEXT)).status, 'done');

    const serialized = JSON.stringify(replacementRequest);
    assert.match(serialized, /REPLACEMENT_QUESTION/);
    assert.doesNotMatch(serialized, /OLD_QUESTION_ONE|OLD_ANSWER_ONE|OLD_QUESTION_TWO|OLD_ANSWER_TWO/);

    const finalContext = await conversation.context(BACKGROUND_CONTEXT);
    const finalMessages = JSON.stringify(finalContext.messages);
    assert.match(finalMessages, /REPLACEMENT_QUESTION|REPLACEMENT_ANSWER/);
    assert.doesNotMatch(finalMessages, /OLD_QUESTION_ONE|OLD_ANSWER_ONE|OLD_QUESTION_TWO|OLD_ANSWER_TWO/);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
