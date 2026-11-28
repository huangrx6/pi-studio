const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('temporary chat restores its own transcript, images and model context after Studio restarts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-temporary-history-'));
  process.env.PI_STUDIO_DB = path.join(root, 'pi-studio.sqlite');
  const durable = await import('@earendil-works/pi-durable');
  const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context');
  const { createModels, fauxAssistantMessage, fauxProvider } = await import('@earendil-works/pi-ai');
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'probe', name: 'Probe', input: ['text', 'image'] }] });
  let secondContext;
  faux.setResponses([
    fauxAssistantMessage('First reply'),
    context => { secondContext = context.messages; return fauxAssistantMessage('Second reply'); },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const studioModels = require('../../electron/main/core/studio-models.cjs');
  t.mock.method(studioModels, 'getStudioModelsRuntime', async () => ({ models }));
  t.mock.method(studioModels, 'getStudioModelsRuntimeSync', () => ({ models }));
  const modelService = require('../../electron/main/services/models.cjs');
  t.mock.method(modelService, 'modelInfo', async () => ({ modelRef: 'faux/probe', thinkingLevel: 'default' }));
  t.mock.method(modelService, 'modelInfoFor', () => ({ modelRef: 'faux/probe', thinkingLevel: 'default', effectiveThinkingLevel: 'off' }));
  t.mock.method(require('../../electron/main/runtime/durable-runtime.cjs'), 'getDurableRuntime',
    async () => ({ durable, context, cleanupSessionResources() {} }));
  const extension = {
    name: 'studio.test', tools: [{
      name: 'summary', description: 'Summarize', parameters: { type: 'object', properties: {} }, replay: 'safe',
      async execute() { return { output: [{ type: 'text', text: 'ok' }] }; },
    }],
  };
  t.mock.method(require('../../electron/main/services/studio-extensions.cjs'), 'temporarySafeExtensions',
    () => [{ extension, toolNames: ['summary'] }]);
  const { getStudioDatabase, closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
  const chat = require('../../electron/main/services/temporary-chat.cjs');
  t.after(async () => {
    await chat.shutdownTemporaryChats();
    closeStudioDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const id = 'restart-test';
  const prompt = { id, text: 'First question', images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }], modelRef: 'faux/probe', thinkingLevel: 'default' };
  const events = [];
  assert.deepEqual(chat.temporaryHistory(), []);
  assert.equal(await chat.temporaryRead('unknown'), null);
  const pending = chat.temporaryPrompt(1, prompt, event => events.push(event));
  await assert.rejects(chat.temporaryPrompt(2, prompt, () => {}), /等待/);
  await pending;
  await chat.closeOwner(1);
  await chat.shutdownTemporaryChats();
  closeStudioDatabase();

  const [summary] = chat.temporaryHistory();
  assert.deepEqual(Object.keys(summary).sort(), ['id', 'title', 'createdAt', 'updatedAt', 'modelRef', 'thinkingLevel'].sort());
  assert.equal(summary.id, id);
  assert.equal(summary.title, prompt.text);
  assert.ok(summary.createdAt > 0 && summary.updatedAt >= summary.createdAt);
  const detail = await chat.temporaryRead(id);
  assert.deepEqual(detail.messages.map(message => message.role), ['user', 'assistant']);
  assert.deepEqual(detail.messages[0].content[1], { type: 'image', ...prompt.images[0] });
  assert.deepEqual(detail.messages[1].content, [{ type: 'text', text: 'First reply' }]);
  const accepted = events.find(event => event.message?.role === 'user');
  assert.deepEqual(accepted.message, detail.messages[0]);

  await chat.temporaryPrompt(2, { ...prompt, text: 'Continue', images: [] }, () => {});
  assert.deepEqual((await chat.temporaryRead(id)).messages.map(message => message.content[0].text),
    ['First question', 'First reply', 'Continue', 'Second reply']);
  assert.match(JSON.stringify(secondContext), /First question/);
  assert.match(JSON.stringify(secondContext), /First reply/);
  // Close the window while the provider is answering. The admitted user input
  // survives cancellation and is still readable with a fresh Harness/SQLite connection.
  const started = Promise.withResolvers();
  faux.setResponses([async (_context, options) => {
    started.resolve();
    await new Promise(resolve => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener('abort', resolve, { once: true });
    });
    return fauxAssistantMessage('Cancelled', { stopReason: 'aborted' });
  }]);
  const interrupted = chat.temporaryPrompt(2, { ...prompt, text: 'Interrupted', images: [] }, () => {});
  await started.promise;
  await Promise.all([chat.closeOwner(2), interrupted]);
  await chat.shutdownTemporaryChats();
  closeStudioDatabase();
  assert.ok((await chat.temporaryRead(id)).messages.some(message =>
    message.role === 'user' && message.content[0].text === 'Interrupted'));
  assert.equal(chat.temporaryHistory().length, 1);
  assert.deepEqual(getStudioDatabase().listConversations(), []);
  assert.deepEqual(getStudioDatabase().listWorkspaces(), []);
});
