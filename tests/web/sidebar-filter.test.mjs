import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSidebarWorkspaces } from '../../web/src/shell/sidebar-filter.ts';

const workspaces = [
  { name: 'Studio', cwd: '/projects/studio', sessionCount: 101, sessions: [
    ...Array.from({ length: 100 }, (_, index) => ({ id: `s${index}`, title: `历史任务 ${index}`, pinned: index === 19, running: index === 42 })),
    { id: 'archived', title: '只在归档中', archived: true, running: true, pinned: true },
  ] },
  { name: 'Library', cwd: '/projects/library', sessionCount: 1, sessions: [{ id: 'other', title: '检查依赖', pinned: true, running: true }] },
  { name: 'Empty', cwd: '/projects/empty', sessions: [] },
];

test('title search narrows a large workspace to matching sessions without changing source order or metadata', () => {
  const original = structuredClone(workspaces);
  const filtered = filterSidebarWorkspaces(workspaces, '  历史任务 42  ', 'all');
  assert.equal(filtered.length, 1);
  assert.deepEqual(filtered[0].sessions.map(session => session.id), ['s42']);
  assert.equal(filtered[0].sessionCount, 101);
  assert.equal(filtered[0].sessions[0], workspaces[0].sessions[42]);
  assert.deepEqual(workspaces, original);
});

test('workspace name and path match all eligible sessions; status filters intersect with text search', () => {
  assert.equal(filterSidebarWorkspaces(workspaces, 'STUDIO', 'all')[0].sessions.length, 100);
  assert.deepEqual(filterSidebarWorkspaces(workspaces, '/PROJECTS/STUDIO', 'running')[0].sessions.map(session => session.id), ['s42']);
  assert.deepEqual(filterSidebarWorkspaces(workspaces, '', 'pinned').flatMap(item => item.sessions.map(session => session.id)), ['s19', 'other']);
  assert.deepEqual(filterSidebarWorkspaces(workspaces, '历史任务 19', 'running'), []);
});

test('archived titles cannot create matches and empty workspaces only survive unfiltered or workspace-name searches', () => {
  assert.deepEqual(filterSidebarWorkspaces(workspaces, '只在归档中', 'all'), []);
  assert.equal(filterSidebarWorkspaces(workspaces, '', 'all').length, 3);
  assert.equal(filterSidebarWorkspaces(workspaces, 'empty', 'all').length, 1);
  assert.deepEqual(filterSidebarWorkspaces(workspaces, 'empty', 'running'), []);
  assert.deepEqual(filterSidebarWorkspaces([], '', 'all'), []);
});
