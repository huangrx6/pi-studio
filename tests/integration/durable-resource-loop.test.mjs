import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  Harness,
  MemoryStorage,
  createRegistry,
} from '@earendil-works/pi-durable';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import { createReadTool } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';

const require = createRequire(import.meta.url);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-durable-resources-'));
process.env.PI_STUDIO_USER_DATA = path.join(temporary, 'user-data');
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const {
  closeStudioDatabase,
} = require('../../electron/core/studio-db.cjs');
const {
  skillInstructions,
} = require('../../electron/services/studio-skills.cjs');

after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function offeredTools(messages) {
  return messages.flatMap((message) => (
    message.role === 'system' ? message.toolsAdded ?? [] : []
  ));
}

function activeSection(messages, key) {
  let value;
  for (const message of messages) {
    if (message.role !== 'system' || !message.sections
      || !Object.hasOwn(message.sections, key)) continue;
    value = message.sections[key] ?? undefined;
  }
  return value;
}

function fauxHarness(registry, responses, options = {}) {
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'Resource probe' }],
  });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    faux,
    models,
    open: () => Harness.open(
      new MemoryStorage(),
      {
        models,
        registry,
        ...(options.env ? { env: () => options.env } : {}),
      },
      BACKGROUND_CONTEXT,
    ),
  };
}

test('Durable exposes a searched deferred tool on the next request and keeps hidden tools unreachable', async () => {
  const registry = createRegistry();
  let executed = false;
  registry.install({
    name: 'probe-mcp',
    tools: [
      {
        name: 'mcp__docs__search',
        label: 'docs/search',
        description: 'Search project documentation for exact references.',
        parameters: Type.Object({ query: Type.String() }),
        deferred: true,
        async execute({ query }) {
          executed = true;
          return { output: [{ type: 'text', text: `found:${query}` }] };
        },
      },
      {
        name: 'mcp__docs__internal',
        label: 'docs/internal',
        description: 'Internal hidden operation.',
        parameters: Type.Object({}),
        callers: ['tools'],
        async execute() {
          return { output: [{ type: 'text', text: 'internal' }] };
        },
      },
    ],
  });
  registry.install(createToolSearchExtension());

  const requests = [];
  const probe = fauxHarness(registry, [
    (context) => {
      requests.push(offeredTools(context.messages).map((tool) => tool.name));
      return fauxAssistantMessage(
        fauxToolCall('tool_search', { query: 'documentation search' }, { id: 'search-tools' }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      requests.push(offeredTools(context.messages).map((tool) => tool.name));
      return fauxAssistantMessage(
        fauxToolCall('mcp__docs__search', { query: 'installation' }, { id: 'call-mcp' }),
        { stopReason: 'toolUse' },
      );
    },
    () => fauxAssistantMessage('Resource round complete.'),
  ]);

  const harness = await probe.open();
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    });
    const before = await conversation.agent(BACKGROUND_CONTEXT);
    assert.deepEqual(before.tools.map((tool) => tool.name), ['tool_search']);
    assert.deepEqual(before.deferred.map((tool) => tool.name), ['mcp__docs__search']);

    const submission = await conversation.submit({
      type: 'input',
      content: 'Find the installation documentation.',
    }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);

    assert.equal(settled.status, 'done');
    assert.equal(executed, true);
    assert.deepEqual(requests, [
      ['tool_search'],
      ['tool_search', 'mcp__docs__search'],
    ]);
    assert.equal(requests.flat().includes('mcp__docs__internal'), false);

    const after = await conversation.agent(BACKGROUND_CONTEXT);
    assert.deepEqual(after.tools.map((tool) => tool.name), [
      'tool_search',
      'mcp__docs__search',
    ]);
    assert.deepEqual(after.deferred, []);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test('Skill routing metadata is rediscovered between tool turns of the same run', async () => {
  const durable = await import('@earendil-works/pi-durable');
  const workspace = path.join(temporary, 'skill-workspace');
  const skillDirectory = path.join(
    process.env.PI_STUDIO_USER_DATA,
    'skills',
    'loop-skill',
  );
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(skillDirectory, { recursive: true });
  const skillFile = path.join(skillDirectory, 'SKILL.md');
  const writeSkill = (description) => fs.writeFileSync(skillFile, [
    '---',
    'name: loop-skill',
    `description: ${description}`,
    '---',
    '',
    'Use the current instructions.',
  ].join('\n'));
  writeSkill('OLD_ROUTING_DESCRIPTION');

  const registry = createRegistry();
  registry.install({
    name: 'probe-tools',
    tools: [
      durable.defineTool({
        name: 'read',
        description: 'Read a file.',
        parameters: Type.Object({ path: Type.String() }),
        async execute() {
          return { output: [{ type: 'text', text: 'read' }] };
        },
      }),
      durable.defineTool({
        name: 'checkpoint',
        description: 'Change the skill on disk.',
        parameters: Type.Object({}),
        async execute() {
          writeSkill('NEW_ROUTING_DESCRIPTION');
          return { output: [{ type: 'text', text: 'changed' }] };
        },
      }),
    ],
    sections: [
      durable.section('studio-skills', (input) => skillInstructions(
        input.agent?.cwd || workspace,
        input.agent?.tools,
      )),
    ],
  });

  const prompts = [];
  const probe = fauxHarness(registry, [
    (context) => {
      prompts.push(activeSection(context.messages, 'studio-skills'));
      return fauxAssistantMessage(
        fauxToolCall('checkpoint', {}, { id: 'change-skill' }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      prompts.push(activeSection(context.messages, 'studio-skills'));
      return fauxAssistantMessage('Skill loop complete.');
    },
  ]);

  const harness = await probe.open();
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'faux', modelId: 'faux-1' },
        cwd: workspace,
      },
    });
    const submission = await conversation.submit({
      type: 'input',
      content: 'Exercise skill discovery.',
    }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);

    assert.equal(settled.status, 'done');
    assert.match(prompts[0], /OLD_ROUTING_DESCRIPTION/);
    assert.doesNotMatch(prompts[0], /NEW_ROUTING_DESCRIPTION/);
    assert.match(prompts[1], /NEW_ROUTING_DESCRIPTION/);
    assert.doesNotMatch(prompts[1], /OLD_ROUTING_DESCRIPTION/);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test('the official read tool loads a user Skill body outside the workspace', async () => {
  const durable = await import('@earendil-works/pi-durable');
  const workspace = path.join(temporary, 'skill-reader-workspace');
  const skillDirectory = path.join(
    temporary,
    'reader-user-data',
    'skills',
    'outside-workspace',
  );
  const previousUserData = process.env.PI_STUDIO_USER_DATA;
  process.env.PI_STUDIO_USER_DATA = path.join(temporary, 'reader-user-data');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(skillDirectory, { recursive: true });
  const skillFile = path.join(skillDirectory, 'SKILL.md');
  fs.writeFileSync(skillFile, [
    '---',
    'name: outside-workspace',
    'description: Load a body that is intentionally outside the active workspace.',
    '---',
    '',
    'SKILL_BODY_FROM_USER_DATA',
  ].join('\n'));

  const registry = createRegistry();
  let readResult;
  const read = createReadTool();
  registry.install({
    name: 'skill-reader',
    tools: [{
      ...read,
      async execute(args, api, context) {
        readResult = await read.execute(args, api, context);
        return readResult;
      },
    }],
    sections: [
      durable.section('studio-skills', (input) => skillInstructions(
        input.agent?.cwd || workspace,
        input.agent?.tools,
      )),
    ],
  });

  const probe = fauxHarness(registry, [
    () => fauxAssistantMessage(
      fauxToolCall('read', { path: skillFile }, { id: 'read-skill' }),
      { stopReason: 'toolUse' },
    ),
    () => fauxAssistantMessage('Skill body loaded.'),
  ], { env: new NodeExecutionEnv({ cwd: workspace }) });

  const harness = await probe.open();
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'faux', modelId: 'faux-1' },
        cwd: workspace,
      },
    });
    const submission = await conversation.submit({
      type: 'input',
      content: 'Load the applicable skill.',
    }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);

    assert.equal(settled.status, 'done');
    const text = readResult.output
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    assert.match(text, /SKILL_BODY_FROM_USER_DATA/);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    if (previousUserData === undefined) delete process.env.PI_STUDIO_USER_DATA;
    else process.env.PI_STUDIO_USER_DATA = previousUserData;
  }
});
