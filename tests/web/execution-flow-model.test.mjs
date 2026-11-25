import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExecutionFlowGraph,
  buildExecutionPhases,
  buildWrappedPhaseFlow,
  summarizeTurnPhases,
} from '../../web/src/features/conversation/execution-flow-model.ts';

const thinkingEntry = (key, text, live = false) => ({
  kind: 'thinking',
  key,
  live,
  block: { type: 'thinking', thinking: text },
});

const toolEntry = (key, id, name, args = {}, live = false) => ({
  kind: 'tool',
  key,
  live,
  call: { type: 'toolCall', id, name, arguments: args },
});

const okResult = (text = 'ok') => ({ role: 'toolResult', content: [{ type: 'text', text }], isError: false });
const errResult = (text = 'failed') => ({ role: 'toolResult', content: [{ type: 'text', text }], isError: true });

test('clusters mixed command-thought loops without splitting and preserves chronological verify images', () => {
  const entries = [
    thinkingEntry('t0', '检查代码结构'),
    toolEntry('e1', 'r1', 'read', { path: 'src/a.ts' }),
    toolEntry('e2', 'r2', 'grep', { pattern: 'foo' }),
    thinkingEntry('t1', '准备构建'),
    toolEntry('e3', 'c1', 'bash', { command: 'pnpm build' }),
    thinkingEntry('t2', '构建报错，继续查'),
    toolEntry('e4', 'c2', 'bash', { command: 'pnpm test' }),
    toolEntry('e5', 'b1', 'mcp__chrome__take_screenshot', {}),
    toolEntry('e6', 'e1', 'edit', { path: 'src/a.ts' }),
  ];
  const results = new Map([
    ['r1', okResult('code')],
    ['r2', okResult('match')],
    ['c1', errResult('syntax error')],
    ['c2', okResult('passed')],
    ['b1', okResult('screenshot')],
    ['e1', okResult('updated')],
  ]);
  const toolImages = new Map([
    ['b1', [{ src: 'data:image/png;base64,IMG1', alt: 'screen' }]],
  ]);

  const phases = buildExecutionPhases(entries, results, toolImages);
  assert.deepEqual(phases.map((p) => p.category), ['explore', 'command', 'verify', 'edit']);
  assert.equal(phases[0].id, 'phase-t0');
  assert.equal(phases[1].errorCount, 1);
  assert.equal(phases[1].status, 'error');
  assert.equal(phases[1].toolCount, 2);
  assert.equal(phases[2].images.length, 1);
  assert.equal(phases[3].toolCount, 1);

  const graph = buildExecutionFlowGraph(phases, phases[2].id);
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.length, 3);
  assert.equal(graph.nodes[2].data.selected, true);
});

test('streaming morphs an initial thinking phase in-place into the first tool phase without ID drift', () => {
  const liveThought = [thinkingEntry('0-0', '先读配置', true)];
  const step1Phases = buildExecutionPhases(liveThought, new Map());
  assert.equal(step1Phases.length, 1);
  assert.equal(step1Phases[0].id, 'phase-0-0');
  assert.equal(step1Phases[0].category, 'plan');
  assert.equal(step1Phases[0].status, 'running');

  const withRead = [
    thinkingEntry('0-0', '先读配置', false),
    toolEntry('0-1', 'call-1', 'read', { path: 'package.json' }, true),
  ];
  const step2Phases = buildExecutionPhases(withRead, new Map());
  assert.equal(step2Phases.length, 1);
  assert.equal(step2Phases[0].id, 'phase-0-0');
  assert.equal(step2Phases[0].category, 'explore');
  assert.equal(step2Phases[0].status, 'running');
});

test('fans out parallel subagent calls into stacked branch nodes in React Flow graph', () => {
  const entries = [
    toolEntry('0-0', 'r1', 'read', { path: 'README.md' }),
    toolEntry('0-1', 'a1', 'subagent', { role: '前端开发' }),
    toolEntry('0-2', 'a2', 'subagent', { role: '后端开发' }),
    toolEntry('0-3', 'c1', 'bash', { command: 'pnpm test' }),
  ];
  const results = new Map([
    ['r1', okResult()],
    ['a1', okResult()],
    ['a2', okResult()],
    ['c1', okResult()],
  ]);
  const phases = buildExecutionPhases(entries, results);
  assert.equal(phases[1].subBranches?.length, 2);

  const graph = buildExecutionFlowGraph(phases);
  assert.equal(graph.lanes, 2);
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.length, 4);
});

test('buildWrappedPhaseFlow wraps phases into a clean 2D serpentine grid and summarizes turn cleanly', () => {
  const entries = [
    toolEntry('0-0', 'r1', 'read', { path: 'README.md' }),
    toolEntry('0-1', 'e1', 'edit', { path: 'app.ts' }),
    toolEntry('0-2', 'c1', 'bash', { command: 'pnpm test' }),
    toolEntry('0-3', 'b1', 'browser_screenshot', {}),
  ];
  const results = new Map([
    ['r1', okResult()],
    ['e1', okResult()],
    ['c1', okResult()],
    ['b1', okResult()],
  ]);
  const phases = buildExecutionPhases(entries, results);
  assert.equal(summarizeTurnPhases(phases, false), '探索源码、编写修改、执行命令等 4 阶段');

  const wrapped = buildWrappedPhaseFlow(phases, 720, phases[3].id);
  assert.equal(wrapped.nodes.length, 4);
  assert.equal(wrapped.edges.length, 3);
  assert.ok(wrapped.nodes[3].position.y > wrapped.nodes[0].position.y);
  assert.equal(wrapped.nodes[3].data.selected, true);
});
