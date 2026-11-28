import assert from 'node:assert/strict';
import test from 'node:test';
import { dragInspectionBounds, emptyInspection, inspectionActivityListener, inspectionSummary, noticeInspection, restoreInspection } from '../../web/src/shell/session-inspection.ts';

test('activity opens a compact card once per turn and respects subsequent user actions', () => {
  const first = noticeInspection(emptyInspection(), 'turn-1');
  assert.equal(first.mode, 'compact');
  const dismissed = { ...first, mode: 'hidden', position: { right: 40, top: 20 } };
  assert.equal(noticeInspection(dismissed, 'turn-1'), dismissed);
  assert.equal(noticeInspection(dismissed, 'agent-run-from-snapshot', true), dismissed);
  assert.deepEqual(noticeInspection(dismissed, 'turn-2'), { ...dismissed, mode: 'compact', seenTurn: 'turn-2' });
  const expanded = { ...first, mode: 'expanded', tab: 'subagents', childKey: 'child' };
  assert.deepEqual(noticeInspection(expanded, 'turn-2'), { ...expanded, seenTurn: 'turn-2' });
  assert.deepEqual(restoreInspection(expanded), expanded);
  assert.deepEqual(restoreInspection({ mode: 'other', tab: 'unknown', position: { top: NaN, right: 10 } }), emptyInspection());
});

test('moving a resize handle fixes the opposite edges and only changes its own axes', () => {
  const area = { width: 1000, height: 800 };
  const start = { right: 80, top: 60, width: 450, height: 350 };
  const expected = {
    n: { top: 80, height: 330 }, ne: { top: 80, height: 330, right: 50, width: 480 },
    e: { right: 50, width: 480 }, se: { right: 50, width: 480, height: 370 },
    s: { height: 370 }, sw: { width: 420, height: 370 }, w: { width: 420 }, nw: { top: 80, height: 330, width: 420 },
    move: { right: 50, top: 80 },
  };
  for (const [handle, changes] of Object.entries(expected)) {
    assert.deepEqual(dragInspectionBounds(start, area, handle, 30, 20), { ...start, ...changes }, handle);
  }
  const anchored = { ...start, right: 0, top: 0 };
  assert.deepEqual(dragInspectionBounds(anchored, area, 'sw', -120, 90), { ...anchored, width: 570, height: 440 });
  const short = { ...anchored, height: 175 };
  assert.deepEqual(dragInspectionBounds(short, area, 'sw', 0, 0), short, 'clicking without dragging preserves the fitted height');
});

test('resizing respects minimum dimensions and the available message area, even below the minimum', () => {
  const area = { width: 900, height: 640 };
  const start = { right: 80, top: 50, width: 460, height: 300 };
  assert.deepEqual(dragInspectionBounds(start, area, 'ne', -1000, 1000), { right: 220, top: 150, width: 320, height: 200 });
  assert.deepEqual(dragInspectionBounds(start, area, 'ne', 1000, -1000), { right: 0, top: 0, width: 540, height: 350 });
  assert.deepEqual(dragInspectionBounds(start, area, 'sw', -1000, 1000), { right: 80, top: 50, width: 820, height: 590 });
  assert.deepEqual(dragInspectionBounds(start, area, 'move', -1000, 1000), { ...start, right: 440, top: 340 });
  const tiny = { width: 250, height: 160 };
  assert.deepEqual(dragInspectionBounds(start, tiny, 'sw', 1000, -1000), { right: 0, top: 0, ...tiny });
});

test('restoring per-session layouts keeps normal geometry independently of the maximized state', () => {
  const normal = { mode: 'expanded', tab: 'progress', position: { right: 32, top: 8 }, size: { width: 585, height: 407 } };
  assert.deepEqual(restoreInspection(normal), normal);
  const saved = { ...normal, mode: 'hidden', maximized: true, seenTurn: 'a' };
  assert.deepEqual(restoreInspection(saved), saved);
  assert.deepEqual(noticeInspection(restoreInspection(saved), 'b'), { ...saved, mode: 'compact', seenTurn: 'b' });
  assert.deepEqual(restoreInspection({ mode: 'compact' }), { mode: 'compact', tab: 'progress' });
  for (const invalid of [0, -8, NaN, Infinity, '400']) {
    assert.deepEqual(restoreInspection({ size: { width: invalid, height: 400 }, maximized: 'true' }), emptyInspection());
    assert.deepEqual(restoreInspection({ size: { width: 400, height: invalid } }), emptyInspection());
  }
});

test('only a successful task creation or an invoked child notifies the owning conversation', () => {
  const noticed = [];
  const listen = inspectionActivityListener((id, turn) => noticed.push([id, turn]));
  const send = (id, type, payload) => listen({ conversationId: id, type, payload });
  const call = (id, key, name, action) => send(id, 'assistant.completed', { message: {
    content: [{ type: 'toolCall', id: key, name, arguments: { action } }],
  } });
  const done = (id, key, isError, details) => send(id, 'transcript.appended', {
    messages: [{ role: 'toolResult', toolCallId: key, isError, details }],
  });
  const started = (id, key) => send(id, 'tool.execution.started', { name: 'subagent', callId: key, status: 'running' });
  send('A', 'run.started', { inputs: ['a1'] });
  send('B', 'snapshot', { run: { inputs: ['b1'] } });
  call('A', 'same', 'todo', 'createMany');
  call('B', 'same', 'subagent', 'status');
  started('B', 'same');
  done('B', 'same', false);
  call('B', 'read', 'todo', 'list');
  done('B', 'read', false);
  call('A', 'denied', 'todo', 'create');
  done('A', 'denied', true);
  assert.deepEqual(noticed, []);
  done('A', 'same', false, { lastTurnId: 'a1' });
  call('B', 'child', 'subagent', 'spawn');
  started('B', 'child');
  started('B', 'child');
  done('B', 'child', false);
  send('A', 'todo.changed', { turnId: 'a2' });
  call('A', 'immediate', 'subagent', undefined);
  done('A', 'immediate', false);
  call('A', 'cancelled', 'subagent', 'run');
  send('A', 'stream.closed', { reason: 'aborted' });
  started('A', 'cancelled');
  assert.deepEqual(noticed, [['A', 'a1'], ['B', 'b1'], ['A', 'a2']]);
});

test('the compact summary reports the current plan and active children', () => {
  const plan = { scope: 'turn', turnId: 't', tasks: [
    { status: 'completed', subject: '读文件' }, { status: 'in_progress', activeForm: '正在校验' },
    { status: 'pending', subject: '汇总' }, { status: 'deleted' }, { status: 'completed', archivedAt: 1 },
  ] };
  assert.deepEqual(inspectionSummary(plan, [{ status: 'waiting' }, { status: 'completed' }]),
    { title: '正在校验', detail: '1/3 项完成 · 1 个子智能体', activity: 't' });
  assert.equal(inspectionSummary(undefined, [{ status: 'running', task: '核对文档', runId: 'r' }]).activity, 'r');
  assert.equal(inspectionSummary(undefined, [], { enabled: true, status: 'paused', goalId: 'old' }).activity, undefined);
});
