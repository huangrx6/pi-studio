const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_BLOCKS,
  MAX_DEPTH,
  normalizeContent,
  normalizeContentList,
} = require('../../electron/services/studio-extension-ui.cjs');

const owner = { manifestId: 'demo-extension', scope: 'user' };
const actionNormalizer = (raw) => (
  raw && typeof raw === 'object' && typeof raw.kind === 'string' ? raw : undefined
);

test('normalizes composable semantic UI blocks', () => {
  const content = normalizeContentList([
    {
      kind: 'metricGrid',
      columns: 3,
      metrics: [{
        id: 'tokens-per-second',
        label: 'Tok/s',
        value: 58.25,
        unit: 't/s',
        trend: { direction: 'up', label: '+12%', tone: 'positive' },
      }],
    },
    {
      kind: 'tabs',
      activeTab: 'overview',
      tabs: [
        {
          id: 'overview',
          label: '总览',
          content: [{ kind: 'statusList', items: [{ id: 'run', label: '运行中', status: 'active' }] }],
        },
        {
          id: 'details',
          label: '详情',
          content: [{ kind: 'progress', label: '完成度', value: 42, max: 100 }],
        },
      ],
    },
  ], owner, actionNormalizer);

  assert.equal(content[0].kind, 'metricGrid');
  assert.equal(content[0].metrics[0].value, 58.25);
  assert.equal(content[1].activeTab, 'overview');
  assert.equal(content[1].tabs[1].content[0].kind, 'progress');
});

test('data views require a fully qualified contribution id', () => {
  assert.throws(
    () => normalizeContentList([
      { kind: 'dataView', sourceId: 'metrics' },
    ], owner, actionNormalizer),
    /list\.items\[0\]\.sourceId 必须是完整 contribution ID/,
  );
  assert.throws(
    () => normalizeContentList([
      {
        kind: 'dataView',
        sourceId: 'user:metrics/live',
        fallback: [{ kind: 'html', text: '<script />' }],
      },
    ], owner, actionNormalizer),
    /list\.items\[0\]\.fallback\.items\[0\]\.kind 不支持 kind html/,
  );
});

test('reports exact paths for nested collection failures', () => {
  assert.throws(
    () => normalizeContentList([{
      kind: 'list',
      items: [
        { text: 'valid' },
        { text: '' },
      ],
    }], owner, actionNormalizer),
    /list\.items\[0\]\.items\[1\]\.text 不能为空/,
  );
});

test('rejects CSS and rendering escape hatches', () => {
  assert.throws(
    () => normalizeContentList([
      { kind: 'metric', id: 'cpu', label: 'CPU', value: 12, color: 'red' },
    ], owner, actionNormalizer),
    /不支持字段 color/,
  );
  assert.throws(
    () => normalizeContentList([
      { kind: 'section', title: 'Unsafe', content: [], style: 'position: fixed' },
    ], owner, actionNormalizer),
    /不支持字段 style/,
  );
});

test('enforces numeric and structural bounds', () => {
  assert.throws(
    () => normalizeContentList([
      { kind: 'sparkline', label: 'NaN', values: [1, Number.NaN] },
    ], owner, actionNormalizer),
    /values\[1\] 必须是有限数字/,
  );
  assert.throws(
    () => normalizeContentList(Array.from({ length: MAX_BLOCKS + 1 }, () => ({
      kind: 'divider',
    })), owner, actionNormalizer),
    /最多允许 64 项/,
  );

  let nested = { kind: 'text', text: 'deep' };
  for (let index = 0; index <= MAX_DEPTH; index += 1) {
    nested = { kind: 'section', title: `Level ${index}`, content: [nested] };
  }
  assert.throws(
    () => normalizeContent(nested, owner, actionNormalizer),
    /嵌套层级不能超过/,
  );
});

test('validates table columns and cell values', () => {
  assert.throws(
    () => normalizeContentList([{
      kind: 'table',
      columns: [
        { key: 'model', label: '模型' },
        { key: 'model', label: '重复列' },
      ],
      rows: [],
    }], owner, actionNormalizer),
    /column key 不能重复/,
  );
  assert.throws(
    () => normalizeContentList([{
      kind: 'table',
      columns: [{ key: 'model', label: '模型' }],
      rows: [{ model: { unsafe: true } }],
    }], owner, actionNormalizer),
    /必须是标量/,
  );
});

test('rejects duplicate React-facing ids inside repeated UI structures', () => {
  assert.throws(
    () => normalizeContentList([{
      kind: 'metricGrid',
      metrics: [
        { id: 'latency', label: 'First', value: 1 },
        { id: 'latency', label: 'Second', value: 2 },
      ],
    }], owner, actionNormalizer),
    /metric id 重复：latency/,
  );
  assert.throws(
    () => normalizeContentList([{
      kind: 'chart',
      title: 'Trend',
      series: [
        { id: 'tokens', label: 'First', values: [1, 2] },
        { id: 'tokens', label: 'Second', values: [2, 3] },
      ],
    }], owner, actionNormalizer),
    /series id 重复：tokens/,
  );
  assert.throws(
    () => normalizeContentList([{
      kind: 'actions',
      buttons: [
        {
          id: 'open',
          label: 'Open',
          action: { kind: 'openSettings' },
        },
        {
          id: 'open',
          label: 'Open again',
          action: { kind: 'openSettings' },
        },
      ],
    }], owner, actionNormalizer),
    /button id 重复：open/,
  );
});

test('keeps visual hierarchy explicit by allowing one primary action per group', () => {
  assert.throws(
    () => normalizeContentList([{
      kind: 'actions',
      buttons: [
        {
          id: 'save',
          label: '保存',
          tone: 'primary',
          action: { kind: 'openSettings' },
        },
        {
          id: 'publish',
          label: '发布',
          tone: 'primary',
          action: { kind: 'openSettings' },
        },
      ],
    }], owner, actionNormalizer),
    /最多只能有一个 primary 操作/,
  );
});
