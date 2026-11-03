import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as durable from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import * as piAi from '@earendil-works/pi-ai';
import * as chordContext from '@earendil-works/chord/context';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-secret-boundary-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');
process.env.PI_STUDIO_USER_DATA = path.join(temporary, 'user-data');
require('../electron/helpers/electron-safe-storage.cjs').installElectronSafeStorage({ after });
const { getStudioDatabase, closeStudioDatabase } = require('../../electron/core/studio-db.cjs');
const { setPermissionMode } = require('../../electron/core/app-settings.cjs');
const { createStudioBuiltins } = require('../../electron/services/studio-builtins.cjs');
const { createSecretAwareRegistry } = require('../../electron/services/secret-tool-runtime.cjs');
after(() => { closeStudioDatabase(); fs.rmSync(temporary, { recursive: true, force: true }); });

test('credentials never enter Durable intent, progress, nested calls or transcript', { timeout: 10_000 }, async () => {
  const secret = 'credential-value-for-integration';
  const reference = '{{secret:TEST_CREDENTIAL}}';
  getStudioDatabase().writeSecretValue('TEST_CREDENTIAL', secret);
  setPermissionMode('full');
  const registry = createSecretAwareRegistry(durable.createRegistry());
  const builtins = createStudioBuiltins({ durable, piAi, chordContext, codingTools: CodingTools, toolSearch: createToolSearchExtension() });
  registry.install(builtins.get('builtin:studio-permissions'));
  let executed = 0;
  const parameters = { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] };
  registry.install({ name: 'secret-probe', tools: [
    {
      name: 'probe', description: 'Exercise the credential boundary.', parameters,
      async execute({ token }, api, context) {
        executed += 1;
        assert.equal(token, secret);
        api.output(token.slice(0, 16));
        await api.details({ credential: token }, context);
        api.output(token.slice(16));
        api.diagnostic({ code: 'probe', message: token });
        const nested = await api.executeTool('inner', { token }, context);
        assert.equal(JSON.stringify(nested).includes(secret), false);
        return { output: [{ type: 'text', text: token }], details: { [token]: token } };
      },
    },
    {
      name: 'inner', description: 'A nested error.', parameters,
      async execute({ token }) { assert.equal(token, secret); throw new Error(`failure: ${token}`); },
    },
  ] });
  const faux = piAi.fauxProvider({ provider: 'faux', models: [{ id: 'probe', name: 'Probe' }] });
  faux.setResponses([
    () => piAi.fauxAssistantMessage(piAi.fauxToolCall('probe', { token: reference }), { stopReason: 'toolUse' }),
    () => piAi.fauxAssistantMessage('Done'),
  ]);
  const models = piAi.createModels();
  models.setProvider(faux.provider);
  const writes = [];
  class RecordingStorage extends durable.MemoryStorage {
    commit(batches, receive, context) {
      writes.push(JSON.stringify(batches));
      return super.commit(batches, receive, context);
    }
  }
  const context = chordContext.BACKGROUND_CONTEXT;
  const harness = await durable.Harness.open(new RecordingStorage(), { models, registry }, context);
  try {
    const conversation = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'probe' } } });
    const watch = await conversation.watch(context);
    const frames = [];
    watch.start(async (call) => { if (call.kind === 'value') frames.push(JSON.stringify(call.value)); });
    const submission = await conversation.submit({ type: 'input', content: 'Run the probe.' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    await watch.stop();
    assert.equal(executed, 1);
    assert.ok(writes.some((write) => write.includes(reference)));
    for (const serialized of [...writes, ...frames]) {
      assert.equal(serialized.includes(secret), false, 'plaintext must never cross the persistence boundary');
      assert.equal(serialized.includes(secret.slice(0, 16)), false, 'stream chunks must not leak credential prefixes');
    }
  } finally { await harness.close(context); }
});
