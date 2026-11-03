'use strict';

/**
 * API 面守卫。
 *
 * Pi Durable 的 minor 版本会直接删改 API（1.5.0 删掉了 `watchEvents()`、
 * `Harness.taskGraph()` 和 `pi-ai` 的 `Type` 再导出）。这个测试把 Studio
 * 实际依赖的符号固定下来：上游一旦删除任何一项，`pnpm test` 立刻失败，
 * 而不是等用户机器上运行时崩溃。
 *
 * 升级依赖时同步更新下面的清单，并在 docs/upgrades/ 留下记录。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

/** '@earendil-works/pi-durable' 等模块必须具备的运行时导出。 */
const MODULE_EXPORTS = {
  '@earendil-works/pi-durable': [
    'Harness',
    'MemoryStorage',
    'createRegistry',
    'createSession',
    'defineDoc',
    'defineExtension',
    'defineTask',
    'defineTool',
  ],
  '@earendil-works/pi-ai': [
    'createModels',
    'getSupportedThinkingLevels',
  ],
  '@earendil-works/chord/context': [
    'BACKGROUND_CONTEXT',
  ],
  '@earendil-works/pi-mcp': [
    'McpClient',
    'StdioTransport',
    'StreamableHttpTransport',
    'toLlmContent',
  ],
  '@earendil-works/pi-telemetry': [
    'NOOP_TELEMETRY_CONTEXT',
  ],
};

/** Harness 实例上 Studio 直接调用的方法。 */
const HARNESS_METHODS = [
  'close',
  'commit',
  'conversation',
  'createConversation',
  'getTask',
  'inspect',
  'resume',
  'root',
  'watchTaskGraph',
];

/** Conversation 句柄上 Studio 直接调用的方法。 */
const CONVERSATION_METHODS = [
  'abort',
  'agent',
  'commit',
  'configure',
  'entries',
  'submit',
  'watch',
];

const REEXPORT_HINT = '若这是有意的上游升级，请同步更新本清单与 docs/upgrades/。';

async function loadModule(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    assert.fail(`无法加载 ${specifier}：${error.message}。${REEXPORT_HINT}`);
  }
}

test('Studio 依赖的上游模块导出仍然存在', async () => {
  for (const [specifier, names] of Object.entries(MODULE_EXPORTS)) {
    const module = await loadModule(specifier);
    for (const name of names) {
      assert.notEqual(
        module[name],
        undefined,
        `${specifier} 不再导出 ${name}。${REEXPORT_HINT}`,
      );
    }
  }
});

test('Harness 与 Conversation 的实例契约仍然存在', async () => {
  const durable = await loadModule('@earendil-works/pi-durable');
  const piAi = await loadModule('@earendil-works/pi-ai');
  const { BACKGROUND_CONTEXT } = await loadModule('@earendil-works/chord/context');

  const harness = await durable.Harness.open(
    new durable.MemoryStorage(),
    { registry: durable.createRegistry(), models: piAi.createModels([]) },
    BACKGROUND_CONTEXT,
  );
  try {
    for (const method of HARNESS_METHODS) {
      assert.equal(
        typeof harness[method],
        'function',
        `Harness 不再提供 ${method}()。${REEXPORT_HINT}`,
      );
    }

    const conversation = await harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      BACKGROUND_CONTEXT,
    );
    for (const method of CONVERSATION_METHODS) {
      assert.equal(
        typeof conversation[method],
        'function',
        `Conversation 不再提供 ${method}()。${REEXPORT_HINT}`,
      );
    }
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test('defineTool 接受纯 JSON Schema 作为 parameters', async () => {
  // Studio 的工具参数 schema 由 electron/runtime/tool-schema.cjs 生成纯
  // JSON Schema，不依赖 TypeBox 或 pi-schema。上游若要求特定构造器，
  // 这里会先失败。
  const durable = await loadModule('@earendil-works/pi-durable');
  const tool = durable.defineTool({
    name: 'schema_probe',
    description: 'Guard: parameters must accept plain JSON Schema.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 8 } },
      required: ['query'],
    },
    replay: 'safe',
    async execute() {
      return { output: [] };
    },
  });

  assert.equal(tool.name, 'schema_probe');
  assert.equal(tool.parameters.properties.query.type, 'string');
  assert.deepEqual(tool.parameters.required, ['query']);
});
