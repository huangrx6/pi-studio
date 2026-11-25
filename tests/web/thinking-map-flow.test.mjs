import assert from 'node:assert/strict';
import test from 'node:test';
import { buildThinkingMapFlow, THINKING_MAP_NODE, thinkingEdgeState, thinkingMapViewport } from '../../web/src/features/conversation/thinking-map-flow.ts';

function step(id, status = 'done', kind = 'thinking') {
  return {
    id,
    kind,
    title: id,
    preview: id,
    detail: '',
    status,
    live: status === 'running',
  };
}

test('thinking map wraps a chain across rows without breaking its order', () => {
  const graph = buildThinkingMapFlow([
    step('a'),
    step('b', 'running', 'command'),
    step('c', 'error', 'browser'),
    step('d'), step('e'),
  ], 644, 'b');
  const [a, b, c, d, e] = graph.nodes;
  assert.deepEqual(graph.edges.map(({ source, target }) => [source, target]), [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']]);
  assert.equal(graph.nodes[1].data.selected, true);
  assert.ok(b.position.x > a.position.x);
  assert.equal(c.position.x, d.position.x);
  assert.ok(d.position.y > c.position.y);
  assert.equal(c.sourcePosition, 'bottom');
  assert.equal(d.targetPosition, 'top');
  assert.ok(e.position.x < d.position.x);
  assert.equal(d.sourcePosition, 'left');
  assert.equal(e.targetPosition, 'right');
  assert.equal(graph.edges[1].className, 'thinking-map-edge is-error');
  assert.equal(thinkingEdgeState('running'), 'active');
});

test('empty thinking map flow stays empty', () => {
  const graph = buildThinkingMapFlow([], 644);
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
});

test('small canvases use one column when there is insufficient width', () => {
  const graph = buildThinkingMapFlow(['a', 'b', 'c'].map(id => step(id)), 320);
  assert.equal(new Set(graph.nodes.map(node => node.position.x)).size, 1);
  assert.equal(new Set(graph.nodes.map(node => node.position.y)).size, 3);
  assert.equal(graph.nodes[1].sourcePosition, 'bottom');
});

test('initial view fits a dozen steps and focuses the selected step in long chains', () => {
  const size = { width: 644, height: 530 };
  const makeGraph = count => buildThinkingMapFlow(Array.from({ length: count }, (_, i) => step(String(i))), size.width);
  const short = makeGraph(12);
  const fit = thinkingMapViewport(short, size, short.nodes.at(-1));
  assert.ok(fit.zoom >= 0.85);
  assert.ok(fit.x > 0 && fit.y > 0 && fit.x + short.bounds.width * fit.zoom < size.width);
  assert.ok(fit.y + short.bounds.height * fit.zoom < size.height);
  const long = makeGraph(60);
  const last = long.nodes.at(-1);
  const focus = thinkingMapViewport(long, size, last);
  assert.equal(focus.zoom, 1);
  assert.ok(focus.x + last.position.x >= 0 && focus.x + last.position.x + THINKING_MAP_NODE.width <= size.width);
  assert.equal(focus.y + last.position.y + THINKING_MAP_NODE.height, size.height - 20);
  const narrowSize = { width: 544, height: 198 };
  const narrow = buildThinkingMapFlow(short.nodes.map(node => node.data.step), narrowSize.width);
  const top = thinkingMapViewport(narrow, narrowSize, narrow.nodes[0]);
  assert.equal(top.x, (narrowSize.width - narrow.bounds.width) / 2);
  assert.equal(top.y, 20);
  assert.ok(top.y + narrow.nodes[3].position.y + THINKING_MAP_NODE.height <= narrowSize.height);
});
