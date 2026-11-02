import assert from 'node:assert/strict';
import test from 'node:test';

import { placeRequestTraces, requestTraceTargetTurnIndex } from '../../web/src/lib/request-trace-turns.ts';

const turns = [
  { kind: 'user', message: { timestamp: 100 } },
  { kind: 'assistant', messages: [{ timestamp: 110, taskId: 'previous-task' }] },
  { kind: 'user', message: { timestamp: 200 } },
  { kind: 'assistant', messages: [{ timestamp: 210, taskId: 'next-task' }] },
];

function trace({ taskId, createdAt, userTimestamp }) {
  return {
    taskId,
    createdAt,
    messages: [
      { role: 'system', timestamp: createdAt - 2 },
      { role: 'user', timestamp: userTimestamp },
    ],
  };
}

test('a late retry stays with its originating user turn after a later answer exists', () => {
  assert.equal(
    requestTraceTargetTurnIndex(trace({
      taskId: 'previous-task',
      createdAt: 180,
      userTimestamp: 100,
    }), turns),
    1,
  );
});

test('a new request maps to its own user turn even when the model is unchanged', () => {
  assert.equal(
    requestTraceTargetTurnIndex(trace({
      taskId: 'next-task',
      createdAt: 200,
      userTimestamp: 200,
    }), turns),
    3,
  );
});

test('an unmatched request uses its Durable task before falling back to timestamps', () => {
  assert.equal(
    requestTraceTargetTurnIndex({
      taskId: 'previous-task',
      createdAt: 180,
      messages: [{ role: 'user', timestamp: 999 }],
    }, turns),
    1,
  );
});

test('a request stays with its Durable task when the request snapshot points elsewhere', () => {
  assert.equal(
    requestTraceTargetTurnIndex({
      taskId: 'next-task',
      createdAt: 150,
      messages: [{ role: 'user', timestamp: 100 }],
    }, turns),
    3,
  );
});

test('a retry without an answer is not attached across a later user turn', () => {
  const turnsWithoutPreviousAnswer = [
    { kind: 'user', message: { timestamp: 100 } },
    { kind: 'user', message: { timestamp: 200 } },
    { kind: 'assistant', messages: [{ timestamp: 210, taskId: 'next-task' }] },
  ];

  assert.equal(
    requestTraceTargetTurnIndex(trace({
      taskId: 'previous-retry',
      createdAt: 180,
      userTimestamp: 100,
    }), turnsWithoutPreviousAnswer),
    -1,
  );
});

test('a request without any visible answer remains unmatched instead of moving forward', () => {
  assert.equal(
    requestTraceTargetTurnIndex(trace({
      taskId: 'not-visible',
      createdAt: 150,
      userTimestamp: 300,
    }), turns),
    -1,
  );
});

function attempt(id, { createdAt, userTimestamp, taskId = id }) {
  return { id, ...trace({ taskId, createdAt, userTimestamp }) };
}

test('failed attempts of an older message stay after that message once a newer message exists', () => {
  const failedTurns = [
    { kind: 'user', message: { timestamp: 100 } },
    { kind: 'user', message: { timestamp: 200 } },
  ];
  const placement = placeRequestTraces({
    traces: [
      attempt('retry-1', { createdAt: 150, userTimestamp: 100 }),
      attempt('retry-2', { createdAt: 160, userTimestamp: 100 }),
      attempt('next', { createdAt: 205, userTimestamp: 200 }),
    ],
    turns: failedTurns,
    turnActive: true,
  });
  assert.deepEqual(placement.unansweredByUserTurn.get(0)?.map((item) => item.id), ['retry-1', 'retry-2']);
  assert.deepEqual(placement.pending.map((item) => item.id), ['next']);
  assert.equal(placement.byAssistantTurn.size, 0);
});

test('attempts of the newest message stay pending when that turn has no answer', () => {
  const placement = placeRequestTraces({
    traces: [
      attempt('retry-1', { createdAt: 150, userTimestamp: 100 }),
      attempt('retry-2', { createdAt: 160, userTimestamp: 100 }),
    ],
    turns: [{ kind: 'user', message: { timestamp: 100 } }],
    turnActive: false,
  });
  assert.deepEqual(placement.pending.map((item) => item.id), ['retry-1', 'retry-2']);
  assert.equal(placement.unansweredByUserTurn.size, 0);
});

test('a running request keeps pending when a steering message arrives during the turn', () => {
  const placement = placeRequestTraces({
    traces: [attempt('running', { createdAt: 120, userTimestamp: 100 })],
    turns: [
      { kind: 'user', message: { timestamp: 100 } },
      { kind: 'user', message: { timestamp: 150 } },
    ],
    turnActive: true,
  });
  assert.deepEqual(placement.pending.map((item) => item.id), ['running']);
  assert.equal(placement.unansweredByUserTurn.size, 0);
});

test('an unanswered attempt stays with its turn when a later message ended without any request', () => {
  const placement = placeRequestTraces({
    traces: [attempt('failed', { createdAt: 150, userTimestamp: 100 })],
    turns: [
      { kind: 'user', message: { timestamp: 100 } },
      { kind: 'user', message: { timestamp: 200 } },
    ],
    turnActive: false,
  });
  assert.deepEqual(placement.unansweredByUserTurn.get(0)?.map((item) => item.id), ['failed']);
  assert.equal(placement.pending.length, 0);
});

test('answered attempts are placed on their assistant turn', () => {
  const placement = placeRequestTraces({
    traces: [attempt('next-task', { createdAt: 200, userTimestamp: 200, taskId: 'next-task' })],
    turns,
    turnActive: false,
  });
  assert.deepEqual(placement.byAssistantTurn.get(3)?.map((item) => item.id), ['next-task']);
  assert.equal(placement.pending.length, 0);
});
