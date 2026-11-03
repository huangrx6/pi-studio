'use strict';

/**
 * 工具参数 schema 构造器。
 *
 * 背景：Studio 的工具参数一直是 TypeBox 形状的 JSON Schema，但 TypeBox 由
 * `@earendil-works/pi-ai` 再导出。Pi Durable 1.5.0 移除了 TypeBox（改用
 * pi-schema），`piAi.Type` 变 undefined，所有 `defineTool()` 调用都会崩。
 *
 * 这里提供同名的 9 个构造器，输出与 TypeBox 1.3.27 逐字节一致的普通 JSON
 * Schema。`defineTool()` 在 1.4.0 和 1.5.0 上都接受任意 JSON Schema，所以
 * 这次迁移对模型看到的工具签名没有任何影响。
 *
 * 两个刻意的决定：
 *
 * 1. **输出保持"开放"**。TypeBox 的 `Type.Object()` 不写
 *    `additionalProperties`，pi-schema 的 `obj()` 默认写 `false`。改成闭集
 *    会让模型多传字段时工具直接报参数错误，属于行为变化，不在本次范围。
 * 2. **`format` 只是注解**。JSON Schema 里 `format` 是否校验由校验器决定，
 *    Studio 不在构造器里做任何校验。
 *
 * 迁移到 pi-schema 是另一个独立的决定，需要逐个工具评估闭集的取舍，见
 * docs/upgrades/pi-durable-1.5.0.md 的"D1"。
 */

/** 被 `Optional()` 标记为可选的 schema 对象。 */
const optionalSchemas = new WeakSet();

/** 校验器/模型都能读的纯 JSON Schema。 */
function merge(base, options) {
  return options === undefined ? base : { ...base, ...options };
}

/**
 * `{ type: 'object', properties, required? }`。
 * `required` 只包含未被 `Optional()` 标记的属性，且为空时整个键省略
 * （与 TypeBox 一致）。
 */
function object(properties, options) {
  const schema = { type: 'object' };
  const required = Object.keys(properties).filter((key) => !optionalSchemas.has(properties[key]));
  if (required.length > 0) schema.required = required;
  schema.properties = properties;
  return merge(schema, options);
}

function string(options) {
  return merge({ type: 'string' }, options);
}

function number(options) {
  return merge({ type: 'number' }, options);
}

function boolean(options) {
  return merge({ type: 'boolean' }, options);
}

function array(items, options) {
  return merge({ type: 'array', items }, options);
}

function union(schemas, options) {
  return merge({ anyOf: schemas }, options);
}

function literal(value) {
  return { type: typeof value, const: value };
}

/**
 * 标记为可选属性：返回一个浅拷贝，标记只作用在这个拷贝上。
 *
 * 用拷贝而不是就地标记，是为了与 TypeBox 一致：共享同一个 schema 对象时，
 * `Object({ a: shared, b: Optional(shared) })` 里只有 `b` 是可选的。
 */
function optional(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const copy = { ...schema };
  optionalSchemas.add(copy);
  return copy;
}

/**
 * 原样透传一个已有 schema。用于 MCP 工具把服务器给的 `inputSchema`
 * 直接交给 `defineTool()`——它本来就是 JSON Schema。
 */
function unsafe(schema) {
  return schema;
}

module.exports = {
  Object: object,
  String: string,
  Number: number,
  Boolean: boolean,
  Array: array,
  Union: union,
  Literal: literal,
  Optional: optional,
  Unsafe: unsafe,
};
