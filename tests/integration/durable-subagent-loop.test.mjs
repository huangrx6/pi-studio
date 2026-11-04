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
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import toolSchema from '../../electron/runtime/tool-schema.cjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-subagent-loop-'));
process.env.PI_STUDIO_USER_DATA = path.join(temporary, 'user-data');
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const require = createRequire(import.meta.url);
const {
  closeStudioDatabase,
} = require('../../electron/core/studio-db.cjs');
const {
  setSubagentConfig,
} = require('../../electron/core/app-settings.cjs');
const {
  createStudioBuiltins,
} = require('../../electron/runtime/builtin-registry.cjs');
const {
  discardManagedWorktree,
  listManagedWorktrees,
} = require('../../electron/capabilities/subagents/index.cjs');

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
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    BACKGROUND_CONTEXT,
  );

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

test('a background subagent report carries the child answer instead of "without a text answer"', async () => {
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
  const { createProtocol } = { createProtocol: require('../../electron/capabilities/subagents/index.cjs').createProtocol };

  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'Subagent background probe' }],
  });
  faux.setResponses([
    () => fauxAssistantMessage(
      fauxToolCall('subagent', {
        action: 'spawn',
        name: 'bg-1',
        task: 'Answer with the background child result.',
      }, { id: 'call-spawn' }),
      { stopReason: 'toolUse' },
    ),
    () => fauxAssistantMessage('background child answer'),
    () => fauxAssistantMessage('parent acknowledged'),
  ]);

  const registry = createRegistry();
  registry.install(subagents);
  registry.install(subagentChannel);
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
        model: { provider: 'faux', modelId: 'faux-1' },
        extensions: [subagents, subagentChannel],
        tools: [subagentTool],
      },
    });
    const parentId = conversation.id;
    const protocol = createProtocol(durable);
    const submission = await conversation.submit({ type: 'input', content: 'Spawn a background child.' }, BACKGROUND_CONTEXT);
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done');

    const deadline = Date.now() + 10_000;
    let reporterId;
    while (Date.now() < deadline) {
      const state = await harness.snapshot(protocol.Subagents, parentId, BACKGROUND_CONTEXT);
      reporterId = state?.agents?.['bg-1']?.lastReporterTaskId;
      if (reporterId) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(reporterId, 'the spawn registers a reporter task');
    await harness.waitForTask(reporterId, BACKGROUND_CONTEXT);

    const settled = await harness.snapshot(protocol.Subagents, parentId, BACKGROUND_CONTEXT);
    const agent = settled.agents['bg-1'];
    // 子会话里的捕获任务把最终回答落进 ChildContext，reporter 正是从这里回读。
    const childContext = await harness.snapshot(protocol.ChildContext, agent.conversationId, BACKGROUND_CONTEXT);
    assert.equal(childContext.lastAnswer, 'background child answer');
    assert.equal(agent.lastStatus, 'completed');
    assert.match(agent.lastReport, /\[subagent bg-1 answered\]/);
    assert.match(agent.lastReport, /background child answer/);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
