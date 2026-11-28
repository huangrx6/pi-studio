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

test('checkout groups keep the exact execution directory and display the main tree first', async () => {
  const { groupSidebarProjects, sidebarProjectKey } = await import('../../web/src/shell/sidebar-projects.ts');
  const main = { cwd: '/repo', name: '我的项目', worktree: { projectRoot: '/repo', branch: 'main', main: true } };
  const secondary = { cwd: '/w/fix', name: 'fix', worktree: { projectRoot: '/repo', branch: 'feat/search', main: false } };
  const folder = { cwd: '/notes', name: '笔记' };
  const groups = groupSidebarProjects([secondary, folder, main]);
  assert.deepEqual(groups.map(group => [group.name, group.nested, group.workspaces.map(item => item.cwd)]), [
    ['我的项目', true, ['/repo', '/w/fix']], ['笔记', false, ['/notes']],
  ]);
  assert.equal(groups[0].key, sidebarProjectKey('/repo'));
  for (const workspace of [main, secondary]) {
    const [solo] = groupSidebarProjects([workspace]);
    assert.equal(solo.nested, true);
    assert.equal(solo.key, sidebarProjectKey('/repo'));
    assert.deepEqual(solo.workspaces, [workspace]);
  }
  assert.equal(groupSidebarProjects([secondary])[0].name, 'repo');
  assert.equal(groupSidebarProjects([{ ...secondary, name: '我的修复分支' }])[0].name, 'repo');
  assert.deepEqual(filterSidebarWorkspaces([secondary, main].map(item => ({ ...item, sessions: [] })), 'feat/search', 'all').map(item => item.cwd), ['/w/fix']);
});

test('a filtered project retains its registered worktree hierarchy and main display name', async () => {
  const { groupSidebarProjects } = await import('../../web/src/shell/sidebar-projects.ts');
  const main = { cwd: '/repo', name: '设计工具', worktree: { projectRoot: '/repo', branch: 'dev', main: true }, sessions: [] };
  const other = { cwd: '/w/fix', name: 'fix', worktree: { projectRoot: '/repo', branch: 'fix', main: false },
    sessions: [{ title: '按钮对齐' }, { title: '检查构建' }] };
  const solo = { cwd: '/docs', name: '文档', worktree: { projectRoot: '/docs', branch: 'main', main: true }, sessions: [] };
  const all = [other, solo, main];
  const visible = filterSidebarWorkspaces(all, '按钮', 'all');
  const [group] = groupSidebarProjects(all, visible);
  assert.equal(group.name, main.name);
  assert.equal(group.nested, true);
  assert.deepEqual(group.workspaces, [visible[0]]);
  assert.deepEqual(group.workspaces[0].sessions, [other.sessions[0]]);
  assert.deepEqual(groupSidebarProjects(all, []), []);
});

test('switching branches updates the worktree label while keeping its project, directory and sessions', async () => {
  const { groupSidebarProjects, workspaceRowTitle } = await import('../../web/src/shell/sidebar-projects.ts');
  const cwd = '/work/notes';
  const sessions = [{ title: '索引测试' }];
  const describe = branch => groupSidebarProjects([{ cwd, name: '笔记', sessions, worktree: { projectRoot: cwd, main: true, branch, detached: false } }])[0];
  const dev = describe('dev'), main = describe('main');
  assert.equal(dev.key, main.key);
  const [tree] = main.workspaces;
  assert.equal(tree.cwd, cwd);
  assert.equal(tree.sessions, sessions);
  assert.equal(workspaceRowTitle(tree), '主工作树 · 笔记\n/work/notes\n当前分支 · main');
  assert.match(workspaceRowTitle({ ...tree, worktree: { ...tree.worktree, detached: true, branch: 'cafe1234' } }), /游离提交 · cafe1234/);
});

test('team rooms match within their own checkout and do not leak into pinned or running filters', () => {
  const group = { cwd: '/project', name: 'project', sessions: [], rooms: [{ id: '1', name: '设计评审' }, { id: '2', name: '开发' }] };
  assert.deepEqual(filterSidebarWorkspaces([group], '评审', 'all')[0].rooms.map(room => room.id), ['1']);
  assert.deepEqual(filterSidebarWorkspaces([group], '', 'running'), []);
  assert.deepEqual(filterSidebarWorkspaces([group], '', 'pinned'), []);
});
