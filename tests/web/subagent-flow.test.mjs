/**
 * Geometry contract for the subagent flow view.
 *
 * The renderer treats this module as the single source of truth for node
 * placement, so these assertions cover the layout the user actually sees:
 * one parent, one member per child, an edge per child, and a parent that stays
 * vertically centred while the member column grows.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  FLOW_MAX_HEIGHT,
  FLOW_MIN_HEIGHT,
  FLOW_MEMBER_NODE,
  FLOW_ROOT_ID,
  FLOW_ROOT_NODE,
  buildSubagentFlow,
  flowCanvasHeight,
  flowEdgeState,
} = await import('../../web/src/features/subagents/subagent-flow.mjs');

const child = (overrides = {}) => ({
  key: 'conversation:1',
  index: 0,
  name: 'scout',
  agent: 'subagent',
  status: 'completed',
  task: '调研',
  tokens: 1_000,
  hasTranscript: true,
  ...overrides,
});

test('builds one parent node plus one member per child', () => {
  const graph = buildSubagentFlow([
    child({ key: 'conversation:1', status: 'running' }),
    child({ key: 'conversation:2', index: 1 }),
    child({ key: 'conversation:3', index: 2, status: 'failed' }),
  ], { rootLabel: 'DeepSeek' });

  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.nodes[0].id, FLOW_ROOT_ID);
  assert.equal(graph.nodes[0].type, 'agentRoot');
  assert.equal(graph.nodes[0].data.label, 'DeepSeek');
  assert.deepEqual(
    graph.nodes.slice(1).map((node) => node.id),
    ['conversation:1', 'conversation:2', 'conversation:3'],
  );
  assert.equal(graph.edges.length, 3);
  assert.ok(graph.edges.every((edge) => edge.source === FLOW_ROOT_ID));
});

test('keeps the parent centred against the member column', () => {
  const graph = buildSubagentFlow([
    child({ key: 'conversation:1' }),
    child({ key: 'conversation:2', index: 1 }),
    child({ key: 'conversation:3', index: 2 }),
  ]);
  const root = graph.nodes[0];
  const members = graph.nodes.slice(1);
  const rootCenter = root.position.y + FLOW_ROOT_NODE.height / 2;
  const memberCenters = members.map((node) => node.position.y + FLOW_MEMBER_NODE.height / 2);
  const memberCenter = (Math.min(...memberCenters) + Math.max(...memberCenters)) / 2;
  assert.ok(Math.abs(rootCenter - memberCenter) <= 1, `${rootCenter} vs ${memberCenter}`);
  assert.equal(new Set(members.map((node) => node.position.x)).size, 1, 'members share one column');
  assert.ok(members.every((node) => node.position.x > root.position.x));
});

test('keeps the caller order from top to bottom', () => {
  const graph = buildSubagentFlow([
    child({ key: 'conversation:1', status: 'failed' }),
    child({ key: 'conversation:2', index: 1, status: 'running' }),
    child({ key: 'conversation:3', index: 2 }),
  ]);
  const ys = graph.nodes.slice(1).map((node) => node.position.y);
  assert.deepEqual([...ys].sort((left, right) => left - right), ys, `order: ${ys.join(',')}`);
});

test('spaces members without overlap and grows the row gap', () => {
  const graph = buildSubagentFlow([child({ key: 'conversation:1' }), child({ key: 'conversation:2', index: 1 })]);
  const [first, second] = graph.nodes.slice(1);
  assert.ok(second.position.y - (first.position.y + FLOW_MEMBER_NODE.height) >= 10);
});

test('marks only live children as animated edges', () => {
  assert.deepEqual(
    buildSubagentFlow([child({ status: 'running' })]).edges.map((edge) => edge.animated),
    [true],
  );
  for (const status of ['completed', 'failed', 'stopped', 'paused', 'waiting']) {
    assert.deepEqual(
      buildSubagentFlow([child({ status })]).edges.map((edge) => edge.animated),
      [false],
      status,
    );
  }
});

test('maps statuses onto the four edge treatments', () => {
  assert.equal(flowEdgeState('running'), 'active');
  assert.equal(flowEdgeState('pending'), 'active');
  assert.equal(flowEdgeState('failed'), 'error');
  assert.equal(flowEdgeState('stopped'), 'error');
  assert.equal(flowEdgeState('waiting'), 'attention');
  assert.equal(flowEdgeState('paused'), 'attention');
  assert.equal(flowEdgeState('completed'), 'settled');
});

test('clamps the canvas height and tolerates empty input', () => {
  assert.equal(flowCanvasHeight(0), FLOW_MIN_HEIGHT);
  assert.equal(flowCanvasHeight(10_000), FLOW_MAX_HEIGHT);
  const empty = buildSubagentFlow([]);
  assert.equal(empty.nodes.length, 1);
  assert.equal(empty.edges.length, 0);
});
