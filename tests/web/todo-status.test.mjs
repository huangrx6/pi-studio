import assert from 'node:assert/strict';
import test from 'node:test';
import { historyTaskStatus, matchesTaskFilter } from '../../web/src/features/conversation/todo-status.ts';

test('task history distinguishes the owner ending from task completion and explicit closure', () => {
  const tasks = [
    { id: 1, status: 'in_progress' }, { id: 2, status: 'pending', blockedBy: [1] },
    { id: 3, status: 'completed', archivedAt: 17 }, { id: 4, status: 'pending', closedAt: 18 },
    { id: 5, status: 'pending', blockedBy: [3, 4, 6] }, { id: 6, status: 'deleted' },
  ];
  const statuses = lifecycle => tasks.slice(0, 5).map(task => historyTaskStatus({ lifecycle, tasks }, task));
  assert.deepEqual(statuses('open'), ['active', 'blocked', 'completed', 'unfinished', 'pending']);
  assert.deepEqual(statuses('unknown'), statuses('open'));
  assert.deepEqual(statuses('ended'), ['unfinished', 'unfinished', 'completed', 'unfinished', 'unfinished']);
  assert.equal(matchesTaskFilter({ lifecycle: 'ended', tasks: [tasks[5]] }, 'all'), false);
  assert.equal(matchesTaskFilter({ lifecycle: 'ended', tasks }, 'active'), false);
  assert.equal(matchesTaskFilter({ lifecycle: 'ended', tasks }, 'incomplete'), true);
  assert.equal(matchesTaskFilter({ lifecycle: 'ended', tasks: [tasks[2]] }, 'incomplete'), false);
});
