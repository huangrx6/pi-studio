import test from 'node:test';
import assert from 'node:assert/strict';
import { filterArchivedWorkspaces } from '../../web/src/features/archives/archive-filter.ts';
const workspaces = [
  { cwd: '/projects/Studio', name: '工作台', sessions: [
    ...Array.from({ length: 350 }, (_, index) => ({ id: `a${index}`, cwd: '/projects/Studio', title: `中文归档 ${index}`, archived: true, pinned: index === 9 })),
    { id: 'live', cwd: '/projects/Studio', title: '未归档特殊标题', archived: false },
  ] },
  { cwd: '/projects/other', name: 'Other', sessions: [{ id: 'b', cwd: '/projects/other', title: '', archived: true }] },
  { cwd: '/empty', name: 'Empty', sessions: [] },
];
test('archive search keeps all large-list results, filters active conversations, and preserves order and source identity', () => {
  const original = structuredClone(workspaces);
  const groups = filterArchivedWorkspaces(workspaces, '');
  assert.equal(groups[0].sessions.length, 350);
  assert.equal(groups[0].sessions[349], workspaces[0].sessions[349]);
  assert.deepEqual(workspaces, original);
  assert.deepEqual(filterArchivedWorkspaces(workspaces, '未归档特殊标题'), []);
  assert.equal(groups.length, 2);
});
test('title, workspace and path terms combine case-insensitively, including normalized fullwidth text', () => {
  assert.deepEqual(filterArchivedWorkspaces(workspaces, '工作台 349')[0].sessions.map(item => item.id), ['a349']);
  assert.equal(filterArchivedWorkspaces(workspaces, '/PROJECTS/STUDIO')[0].sessions.length, 350);
  assert.deepEqual(filterArchivedWorkspaces(workspaces, 'ＯＴＨＥＲ 未命名会话')[0].sessions.map(item => item.id), ['b']);
  assert.deepEqual(filterArchivedWorkspaces(workspaces, 'not-found'), []);
  assert.equal(filterArchivedWorkspaces(workspaces, '  ')[0].sessions.length, 350);
});
