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
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
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

test('a referenced role receives its saved model, Harness, skill subset and allowed MCP service', async () => {
  const { saveSubagentProfile, removeSubagentProfile, resolveProfileMentions } = require('../../electron/main/capabilities/subagents/index.cjs');
  const { saveHarnessProfile } = require('../../electron/main/core/app-settings.cjs');
  const { getStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
  const { discoverSkills, skillReferenceId } = require('../../electron/main/capabilities/skills/index.cjs');
  const workspace = path.join(temporary, 'role-workspace');
  fs.mkdirSync(workspace);
  const db = getStudioDatabase();
  db.upsertProvider({ id: 'faux', name: 'Faux', enabled: true });
  db.upsertModel({ providerId: 'faux', modelId: 'specialist', enabled: true });
  for (const name of ['role-selected', 'role-unselected']) {
    const dir = path.join(process.env.PI_STUDIO_USER_DATA, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), ['---', 'name: ' + name, 'description: ' + name, '---', 'Instructions'].join('\n'));
  }
  const skill = discoverSkills(workspace).skills.find(row => row.name === 'role-selected');
  saveHarnessProfile({ id: 'review-probe', name: '评审', sectionOverrides: { preamble: 'ROLE_HARNESS_CANARY' } });
  setSubagentConfig('user', '', { defaultMode: 'foreground', worktreeIsolation: 'off', allowedTools: [], defaultModel: '', defaultThinking: '' });
  const role = saveSubagentProfile({ name: '评审专员', avatarId: 'olive-braids', description: '审阅指定改动',
    instructions: 'ROLE_INSTRUCTIONS_CANARY', model: 'faux/specialist', skills: [skillReferenceId(skill)],
    mcpServers: ['docs'], harnessId: 'review-probe' }).at(-1);
  const durable = await import('@earendil-works/pi-durable');
  const tool = name => durable.defineTool({ name, description: name, parameters: toolSchema.Object({}),
    replay: 'safe', async execute() { return { output: [{ type: 'text', text: 'ok' }] }; } });
  const coding = defineExtension({ name: 'coding-tools', tools: [tool('read')] });
  const docs = defineExtension({ name: 'studio-mcp:docs', tools: [tool('mcp__docs__find')] });
  const other = defineExtension({ name: 'studio-mcp:other', tools: [tool('mcp__other__find')] });
  const builtins = createStudioBuiltins({ durable, piAi: { Type: toolSchema }, codingTools: coding,
    toolSearch: createToolSearchExtension(), chordContext: BACKGROUND_CONTEXT });
  const manager = builtins.get('builtin:studio-subagents');
  const extensions = [coding, docs, other, builtins.get('builtin:studio-harness'), builtins.get('builtin:studio-skills'),
    manager, builtins.get('builtin:studio-subagent-channel')];
  const registry = createRegistry();
  extensions.forEach(extension => registry.install(extension));
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'parent', name: 'Parent' }, { id: 'specialist', name: 'Specialist' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  let childRequest;
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall('subagent', { profileId: role.id, action: 'run', task: '审阅样例。' },
      { id: 'invoke-role' }), { stopReason: 'toolUse' }),
    (context, _options, _state, model) => {
      childRequest = { model: model.id, transcript: JSON.stringify(context.messages.filter(m => m.role === 'system')) };
      return fauxAssistantMessage('审阅完成');
    },
    () => fauxAssistantMessage('收到角色结果'),
  ]);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  try {
    const parent = await harness.root(BACKGROUND_CONTEXT, { agent: { cwd: workspace, model: { provider: 'faux', modelId: 'parent' },
      extensions, tools: [...coding.tools, ...docs.tools, ...other.tools, manager.tools.find(item => item.name === 'subagent')] } });
    const mention = resolveProfileMentions('@[agent:' + role.id + '|olive-braids|旧称] 请审阅', true);
    const submission = await parent.submit({ type: 'input', content: mention.readable + '\n' + mention.routing }, BACKGROUND_CONTEXT);
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done');
    const token = createProtocol(durable).Subagents;
    const children = await harness.snapshot(token, parent.id, BACKGROUND_CONTEXT);
    const child = Object.values(children.agents)[0];
    assert.ok(child?.conversationId);
    assert.equal(childRequest?.model, 'specialist');
    assert.match(childRequest.transcript, /ROLE_HARNESS_CANARY/);
    assert.match(childRequest.transcript, /ROLE_INSTRUCTIONS_CANARY/);
    assert.match(childRequest.transcript, /role-selected/);
    assert.doesNotMatch(childRequest.transcript, /role-unselected|mcp__other__find/);
    assert.match(childRequest.transcript, /mcp__docs__find/);
    const existing = await harness.conversation(child.conversationId, BACKGROUND_CONTEXT);
    const agent = await existing.agent(BACKGROUND_CONTEXT);
    assert.ok(agent.tools.some(t => t.name === 'mcp__docs__find'));
    assert.ok(![...agent.tools, ...agent.callable, ...agent.deferred].some(t => t.name === 'mcp__other__find' || t.name === 'subagent'));
    assert.equal(child.profileId, role.id);
    assert.equal(child.displayName, role.name);
    assert.equal(child.avatarId, role.avatarId);
    db.upsertModel({ providerId: 'faux', modelId: 'specialist', enabled: false });
    faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall('subagent', { profileId: role.id, task: '再次审阅。' },
        { id: 'disabled-model' }), { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('需要重新选择模型'),
    ]);
    await (await parent.submit({ type: 'input', content: '再调用同一角色。' }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    const entries = await parent.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT);
    const failure = entries.items.flatMap(entry => entry.model || []).find(message => message.role === 'toolResult' && message.toolCallId === 'disabled-model');
    assert.equal(failure?.isError, true);
    assert.match(JSON.stringify(failure.content), /模型已停用或移除/);
    assert.equal(Object.keys((await harness.snapshot(token, parent.id, BACKGROUND_CONTEXT)).agents).length, 1);
    const changed = saveSubagentProfile({ ...role, name: '已改名', avatarId: 'black-hime', instructions: 'NEW_ROLE_INSTRUCTIONS' }).at(-1);
    removeSubagentProfile(changed);
    const replay = await manager.tools.find(item => item.name === 'subagent').execute({
      action: 'run', profileId: role.id, task: '审阅样例。',
    }, {
      taskId: child.ownerTaskId, conversationId: parent.id, now: Date.now, details: async () => {},
      snapshot: harness.snapshot.bind(harness), commit: harness.commit.bind(harness), conversation: harness.conversation.bind(harness),
    }, BACKGROUND_CONTEXT);
    assert.equal(replay.output[0].text, '审阅完成');
    const stored = (await harness.snapshot(token, parent.id, BACKGROUND_CONTEXT)).agents[child.name];
    assert.equal(stored.displayName, role.name);
    assert.equal(stored.avatarId, role.avatarId);
    assert.equal(stored.profileRevision, 1);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test('Durable enforces different file access for two roles and revokes write on the next background message', { timeout: 18000 }, async () => {
  const { saveSubagentProfile } = require('../../electron/main/capabilities/subagents/index.cjs');
  const workspace = path.join(temporary, 'role-permissions');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'FILE_READ_PROBE');
  const role = (name, allowedTools) => saveSubagentProfile({ name, avatarId: 'indigo-bob', description: '文件访问核验',
    instructions: '', model: 'parent', harnessId: '', skills: [], mcpServers: null,
    runtimeOverrides: { allowedTools, maxThinking: 'off' } }).at(-1);
  const reader = role('读取资料', 'read-only'), writer = role('编写资料', 'read-write');
  setSubagentConfig('user', '', { allowedTools: ['read'], defaultModel: 'faux/other', defaultMode: 'foreground',
    worktreeIsolation: 'off', backgroundEnabled: true, supervisorEnabled: false });
  const durable = await import('@earendil-works/pi-durable');
  const piAi = await import('@earendil-works/pi-ai');
  const builtins = createStudioBuiltins({ durable, piAi: { ...piAi, Type: toolSchema }, codingTools: CodingTools,
    toolSearch: createToolSearchExtension(), chordContext: BACKGROUND_CONTEXT });
  const manager = builtins.get('builtin:studio-subagents');
  const extensions = [CodingTools, manager, builtins.get('builtin:studio-subagent-channel')];
  const registry = createRegistry();
  extensions.forEach(ext => registry.install(ext));
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'main', name: 'Main' }, { id: 'other', name: 'Other' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const ctx = BACKGROUND_CONTEXT;
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd }) }, ctx);
  const call = (tool, args, id) => () => fauxAssistantMessage(fauxToolCall(tool, args, { id }), { stopReason: 'toolUse' });
  const answer = () => fauxAssistantMessage('完成');
  try {
    const parent = await harness.root(ctx, { agent: { cwd: workspace, model: { provider: 'faux', modelId: 'main' }, extensions,
      tools: [...CodingTools.tools, manager.tools.find(t => t.name === 'subagent')] } });
    const submit = async text => assert.equal((await (await parent.submit({ type: 'input', content: text }, ctx)).wait(ctx)).status, 'done');
    const state = () => harness.snapshot(createProtocol(durable).Subagents, parent.id, ctx);
    for (const profile of [reader, writer]) {
      const filename = profile.id + '.txt';
      faux.setResponses([call('subagent', { profileId: profile.id, action: 'run', task: '检验读写' }, filename),
        call('read', { path: 'source.txt' }, 'try-read'), call('write', { path: filename, content: 'FILE_WRITE_PROBE' }, 'try-write'),
        answer, answer]);
      await submit(filename);
      const registered = Object.values((await state()).agents).find(r => r.profileId === profile.id);
      assert.ok(registered?.conversationId);
      const child = await harness.conversation(registered.conversationId, ctx);
      const agent = await child.agent(ctx);
      assert.equal(agent.model.modelId, 'main');
      assert.equal(agent.thinkingLevel, 'off');
      assert.ok(![...agent.tools, ...agent.callable, ...agent.deferred].some(t => t.name === 'bash'));
      const results = (await child.entries({ order: 'ascending' }, 100, undefined, ctx)).items.flatMap(entry => entry.model || []);
      assert.match(JSON.stringify(results.find(r => r.toolCallId === 'try-read')?.content), /FILE_READ_PROBE/);
      assert.equal(results.find(r => r.toolCallId === 'try-write')?.isError, profile.id === reader.id);
      assert.equal(fs.existsSync(path.join(workspace, filename)), profile.id === writer.id);
      if (profile.id === writer.id) assert.equal(fs.readFileSync(path.join(workspace, filename), 'utf8'), 'FILE_WRITE_PROBE');
    }
    const name = 'ongoing-role';
    async function background(args, id) {
      faux.setResponses([call('subagent', { name, ...args }, id), ...Array.from({ length: 7 }, () => answer)]);
      await submit(id);
      const agent = (await state()).agents[name];
      await harness.waitForTask(agent.lastReporterTaskId, ctx);
      await parent.waitForIdle(ctx);
      const finished = (await state()).agents[name];
      assert.equal(finished.lastStatus, 'completed', finished.lastReport);
      return (await harness.conversation(agent.conversationId, ctx)).agent(ctx);
    }
    const before = await background({ action: 'spawn', task: '首轮', profileId: writer.id, instructions: 'CALL_INSTRUCTION' }, 'background-start');
    assert.ok(before.tools.some(tool => tool.name === 'write'));
    saveSubagentProfile({ ...writer, instructions: 'UPDATED_ROLE_INSTRUCTION', runtimeOverrides: { ...writer.runtimeOverrides, allowedTools: 'read-only' } });
    const after = await background({ action: 'send', message: '继续' }, 'background-continue');
    assert.ok(after.tools.some(tool => tool.name === 'read'));
    assert.ok(![...after.tools, ...after.callable, ...after.deferred].some(tool => tool.name === 'write' || tool.name === 'edit'));
    assert.match(after.instructions, /UPDATED_ROLE_INSTRUCTION/);
    assert.match(after.instructions, /CALL_INSTRUCTION/);

    const inherited = saveSubagentProfile({ ...reader, id: '', name: '随工作区运行', model: '', runtimeOverrides: { maxThinking: 'off' } }).at(-1);
    for (const grantWrite of [false, true]) {
      if (grantWrite) setSubagentConfig('project', workspace, { allowedTools: ['read', 'write'] });
      const id = grantWrite ? 'updated-common-defaults' : 'original-common-defaults';
      faux.setResponses([call('subagent', { profileId: inherited.id, task: '检查当前工具' }, id), answer, answer]);
      await submit(id);
      const registered = Object.values((await state()).agents).filter(r => r.profileId === inherited.id).at(-1);
      const agent = await (await harness.conversation(registered.conversationId, ctx)).agent(ctx);
      assert.equal(agent.model.modelId, 'other');
      assert.equal(agent.thinkingLevel, 'off');
      assert.ok(agent.tools.some(t => t.name === 'read'));
      assert.equal(agent.tools.some(t => t.name === 'write'), grantWrite);
    }
  } finally {
    await harness.close(ctx);
  }
});
