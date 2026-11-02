import assert from 'node:assert/strict';
import test from 'node:test';

import { requestTraceTargetTurnIndex } from '../../web/src/lib/request-trace-turns.ts';

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
