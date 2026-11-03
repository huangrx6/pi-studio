'use strict';

/**
 * `electron/services/tool-schema.cjs` 的输出契约。
 *
 * fixture 取自 TypeBox 1.3.27（Studio 升级前的实际行为），冻结在这里而不是
 * 从 typebox 包现算——升级后该包不再存在，而这些 schema 会直接进入模型请求，
 * 必须逐字节稳定。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const Type = require('../../electron/services/tool-schema.cjs');

/** 断言输出与冻结的 TypeBox 结果完全一致（含键顺序之外的深比较）。 */
function assertSchema(actual, expected) {
  assert.deepEqual(actual, expected);
  // 键的顺序不影响语义，但保持稳定便于审阅 diff。
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test('Object 只把非 Optional 属性放进 required', () => {
  assertSchema(
    Type.Object({ a: Type.String(), b: Type.Optional(Type.Number()) }),
    { type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: { type: 'number' } } },
  );
});

test('Object 在 required 为空时省略该键', () => {
  assertSchema(
    Type.Object({}),
    { type: 'object', properties: {} },
  );
  assertSchema(
    Type.Object({ only: Type.Optional(Type.Boolean()) }),
    { type: 'object', properties: { only: { type: 'boolean' } } },
  );
});

test('嵌套 Object 逐层保留 required', () => {
  assertSchema(
    Type.Object({ outer: Type.Object({ inner: Type.String() }) }),
    {
      type: 'object',
      required: ['outer'],
      properties: {
        outer: {
          type: 'object',
          required: ['inner'],
          properties: { inner: { type: 'string' } },
        },
      },
    },
  );
});

test('Array 保留 items 与选项顺序', () => {
  assertSchema(
    Type.Object({
      ids: Type.Optional(Type.Array(Type.Number({ minimum: 1 }), {
        maxItems: 5,
        description: 'd',
      })),
    }),
    {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'number', minimum: 1 },
          maxItems: 5,
          description: 'd',
        },
      },
    },
  );
});

test('Union 生成 anyOf，Literal 生成 const', () => {
  assertSchema(
    Type.Object({
      status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress')]),
    }),
    {
      type: 'object',
      required: ['status'],
      properties: {
        status: {
          anyOf: [
            { type: 'string', const: 'pending' },
            { type: 'string', const: 'in_progress' },
          ],
        },
      },
    },
  );
});

test('标量选项原样透传', () => {
  assertSchema(
    Type.Object({
      s: Type.String({
        maxLength: 10,
        minLength: 1,
        pattern: '^a',
        format: 'uri',
        title: 'T',
        default: 'x',
      }),
      n: Type.Number({ minimum: 0, maximum: 9 }),
    }),
    {
      type: 'object',
      required: ['s', 'n'],
      properties: {
        s: {
          type: 'string',
          maxLength: 10,
          minLength: 1,
          pattern: '^a',
          format: 'uri',
          title: 'T',
          default: 'x',
        },
        n: { type: 'number', minimum: 0, maximum: 9 },
      },
    },
  );
});

test('Object 默认是开放集合（不写 additionalProperties）', () => {
  const schema = Type.Object({ a: Type.String() });
  assert.equal('additionalProperties' in schema, false);
});

test('Unsafe 原样透传外部 JSON Schema', () => {
  const external = {
    type: 'object',
    properties: { query: { type: 'string' } },
    additionalProperties: true,
  };
  assert.equal(Type.Unsafe(external), external);
});

test('Optional 只影响包裹它的 Object，不污染共享的 schema 对象', () => {
  const shared = Type.String();
  const schema = Type.Object({ a: shared, b: Type.Optional(shared) });
  assert.deepEqual(schema.required, ['a']);
});
