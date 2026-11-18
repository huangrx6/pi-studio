import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import {
  Harness,
  MemoryStorage,
  ToolResultEntry,
  createRegistry,
  defineExtension,
} from '@earendil-works/pi-durable';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import toolSchema from '../../electron/main/runtime/tool-schema.cjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-subagent-loop-'));
process.env.PI_STUDIO_USER_DATA = path.join(temporary, 'user-data');
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const require = createRequire(import.meta.url);
const {
  closeStudioDatabase,
} = require('../../electron/main/core/studio-db.cjs');
const {
  setSubagentConfig,
} = require('../../electron/main/core/app-settings.cjs');
const {
  createStudioBuiltins,
} = require('../../electron/main/runtime/builtin-registry.cjs');
const {
  createProtocol,
  discardManagedWorktree,
  listManagedWorktrees,
} = require('../../electron/main/capabilities/subagents/index.cjs');

after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('a foreground subagent returns its child answer through the real Durable tool API', async () => {
  setSubagentConfig('user', '', {
    defaultModel: '',
    defaultThinking: '',
    maxThinking: '',
    defaultMode: 'foreground',
    backgroundEnabled: true,
    supervisorEnabled: false,
    allowedTools: [],
  });

  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'Subagent probe' }],
  });
  faux.setResponses([
    () => fauxAssistantMessage(
      fauxToolCall('subagent', {
        action: 'run',
        task: 'Answer with the verified child result.',
      }, { id: 'call-subagent' }),
      { stopReason: 'toolUse' },
    ),
    () => fauxAssistantMessage('child result'),
    () => fauxAssistantMessage('parent received the child result'),
  ]);

  const durable = await import('@earendil-works/pi-durable');
  const builtins = createStudioBuiltins({
    durable,
    piAi: { Type: toolSchema },
    codingTools: defineExtension({ name: 'coding-tools', tools: [] }),
    toolSearch: createToolSearchExtension(),
    chordContext: BACKGROUND_CONTEXT,
  });
  const subagents = builtins.get('builtin:studio-subagents');
  const subagentChannel = builtins.get('builtin:studio-subagent-channel');
  const subagentTool = subagents.tools.find((tool) => tool.name === 'subagent');
  assert.ok(subagentTool);

  const registry = createRegistry();
  registry.install(subagents);
  registry.install(subagentChannel);
  const models = createModels();
  models.setProvider(faux.provider);
  const directory = path.join(temporary, 'foreground');
  const open = async () => Harness.open(await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT), { models, registry }, BACKGROUND_CONTEXT);
  let harness = await open();

  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'faux', modelId: 'faux-1' },
        extensions: [subagents, subagentChannel],
        tools: [subagentTool],
      },
    });
    const submission = await conversation.submit({
      type: 'input',
      content: 'Run the subagent and report its result.',
    }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, 'done');

    const page = await conversation.entries(
      { order: 'ascending' },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const result = page.items
      .filter((entry) => entry.kind === ToolResultEntry.kind)
      .flatMap((entry) => entry.model || [])
      .find((message) => message.role === 'toolResult' && message.toolName === 'subagent');
    assert.ok(result);
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0]?.type, 'text');
    assert.equal(result.content[0]?.text, 'child result');
    const parentId = conversation.id;
    const token = createProtocol(durable).Subagents;
    const readChild = async () => Object.values((await harness.snapshot(token, parentId, BACKGROUND_CONTEXT)).agents)[0];
    const child = await readChild();
    assert.ok(child.avatarId);
    await harness.close(BACKGROUND_CONTEXT);
    harness = await open();
    const restored = await readChild();
    assert.equal(restored.conversationId, child.conversationId);
    assert.equal(restored.avatarId, child.avatarId);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test('an isolated subagent writes in Studio userData without changing the project', async () => {
  const repository = path.join(temporary, 'isolated-repository');
  fs.mkdirSync(repository, { recursive: true });
  execFileSync('git', ['-C', repository, 'init']);
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'Pi Studio Test']);
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'test@pi-studio.invalid']);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'base\n');
  execFileSync('git', ['-C', repository, 'add', '.']);
  execFileSync('git', ['-C', repository, 'commit', '-m', 'initial']);

  setSubagentConfig('user', '', {
    defaultModel: '',
    defaultThinking: '',
    maxThinking: '',
    defaultMode: 'foreground',
    backgroundEnabled: true,
    supervisorEnabled: false,
    allowedTools: [],
    worktreeIsolation: 'background',
    worktreeLimit: 8,
  });

  const durable = await import('@earendil-works/pi-durable');
  const childWrite = durable.defineTool({
    name: 'child_write',
    description: 'Write a file inside the agent workspace.',
    parameters: toolSchema.Object({
      path: toolSchema.String(),
      text: toolSchema.String(),
    }),
    replay: 'safe',
    async execute(args, api, context) {
      const agent = await api.agent(context);
      const target = path.resolve(agent.cwd, args.path);
      if (!target.startsWith(`${path.resolve(agent.cwd)}${path.sep}`)) {
        throw new Error('path escaped workspace');
      }
      fs.writeFileSync(target, args.text);
      return { output: [{ type: 'text', text: 'written' }] };
    },
  });
  const childExtension = durable.defineExtension({
    name: 'test-child-write',
    tools: [childWrite],
  });
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'Subagent isolate probe' }],
  });
  faux.setResponses([
    () => fauxAssistantMessage(
      fauxToolCall('subagent', {
        action: 'run',
        isolation: 'worktree',
        task: 'Write the isolated file and answer.',
      }, { id: 'call-isolated-subagent' }),
      { stopReason: 'toolUse' },
    ),
    () => fauxAssistantMessage(
      fauxToolCall('child_write', {
        path: 'isolated.txt',
        text: 'inside worktree\n',
      }, { id: 'call-child-write' }),
      { stopReason: 'toolUse' },
    ),
    () => fauxAssistantMessage('isolated child result'),
    () => fauxAssistantMessage('parent kept its project unchanged'),
  ]);

  const builtins = createStudioBuiltins({
    durable,
    piAi: { Type: toolSchema, getSupportedThinkingLevels: () => ['off'] },
    codingTools: defineExtension({ name: 'coding-tools', tools: [] }),
    toolSearch: createToolSearchExtension(),
    chordContext: BACKGROUND_CONTEXT,
  });
  const subagents = builtins.get('builtin:studio-subagents');
  const subagentTool = subagents.tools.find((tool) => tool.name === 'subagent');
  const registry = createRegistry();
  registry.install(subagents);
  registry.install(childExtension);
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
        cwd: repository,
        model: { provider: 'faux', modelId: 'faux-1' },
        extensions: [subagents, childExtension],
        tools: [subagentTool, childWrite],
      },
    });
    const submission = await conversation.submit({
      type: 'input',
      content: 'Run this one in an isolated worktree.',
    }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, 'done');
    assert.equal(fs.existsSync(path.join(repository, 'isolated.txt')), false);

    const worktrees = await listManagedWorktrees();
    assert.equal(worktrees.length, 1);
    assert.equal(worktrees[0].status, 'finished');
    assert.equal(fs.readFileSync(path.join(worktrees[0].path, 'isolated.txt'), 'utf8'), 'inside worktree\n');
    await discardManagedWorktree(worktrees[0].id);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test('two background subagents complete and each reports its own answer with Studio writing the same SQLite file', async () => {
  setSubagentConfig('user', '', {
    defaultModel: '',
    defaultThinking: '',
    maxThinking: '',
    defaultMode: 'background',
    backgroundEnabled: true,
    supervisorEnabled: false,
    allowedTools: [],
  });

  const durable = await import('@earendil-works/pi-durable');
  const builtins = createStudioBuiltins({
    durable,
    piAi: { Type: toolSchema, getSupportedThinkingLevels: () => ['off'] },
    codingTools: defineExtension({ name: 'coding-tools', tools: [] }),
    toolSearch: createToolSearchExtension(),
    chordContext: BACKGROUND_CONTEXT,
  });
  const subagents = builtins.get('builtin:studio-subagents');
  const subagentChannel = builtins.get('builtin:studio-subagent-channel');
  const subagentTool = subagents.tools.find((tool) => tool.name === 'subagent');

  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'Subagent background probe' }],
  });
  const names = ['beijing-trip', 'shanghai-trip'];
  let responseNumber = 0;
  const answer = () => fauxAssistantMessage('background answer ' + ++responseNumber);
  faux.setResponses([
    () => fauxAssistantMessage(names.map(name =>
      fauxToolCall('subagent', {
        action: 'spawn',
        name,
        task: 'Return the result for ' + name,
      }, { id: 'call-' + name })),
      { stopReason: 'toolUse' },
    ),
    answer, answer, answer,
  ]);

  const registry = createRegistry();
  registry.install(subagents);
  registry.install(subagentChannel);
  const models = createModels();
  models.setProvider(faux.provider);
  const studio = require('../../electron/main/core/studio-db.cjs').getStudioDatabase();
  const { openDurableStorage } = require('../../electron/main/runtime/durable-storage.cjs');
  const storage = await openDurableStorage(process.env.PI_STUDIO_DB, { prefix: 'durable_', busyTimeoutMs: 1500 });
  const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
  studio.db.exec('CREATE TABLE subagent_projection_probe(value INTEGER)');
  const project = studio.db.prepare("INSERT INTO subagent_projection_probe(value) VALUES(?)");
  let writes = 0;
  const timer = setInterval(() => project.run(String(++writes)), 5);

  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'faux', modelId: 'faux-1' },
        extensions: [subagents, subagentChannel],
        tools: [subagentTool],
      },
    });
    const parentId = conversation.id;
    const protocol = createProtocol(durable);
    const submission = await conversation.submit({ type: 'input', content: 'Spawn both background children.' }, BACKGROUND_CONTEXT);
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done');

    const deadline = Date.now() + 10_000;
    let reporters = [];
    while (Date.now() < deadline) {
      const state = await harness.snapshot(protocol.Subagents, parentId, BACKGROUND_CONTEXT);
      reporters = names.map(name => state?.agents?.[name]?.lastReporterTaskId).filter(Boolean);
      if (reporters.length === names.length) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(reporters.length, 2);
    await Promise.all(reporters.map(id => harness.waitForTask(id, BACKGROUND_CONTEXT)));
    const settled = await harness.snapshot(protocol.Subagents, parentId, BACKGROUND_CONTEXT);
    const childAnswers = new Set();
    for (const name of names) {
      const agent = settled.agents[name];
      const child = await harness.snapshot(protocol.ChildContext, agent.conversationId, BACKGROUND_CONTEXT);
      assert.match(child.lastAnswer, /^background answer [1-3]$/);
      childAnswers.add(child.lastAnswer);
      assert.equal(agent.lastStatus, 'completed');
      assert.ok(agent.lastReport.includes('[subagent ' + name + ' answered]'));
      assert.ok(agent.lastReport.includes(child.lastAnswer));
    }
    assert.equal(childAnswers.size, names.length);
    assert.ok(writes > 0);
  } finally {
    clearInterval(timer);
    await harness.close(BACKGROUND_CONTEXT);
  }
});
