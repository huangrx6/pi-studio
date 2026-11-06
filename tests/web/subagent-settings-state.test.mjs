import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubagentSettingsOwner, createSubagentSettingsWrites } from '../../web/src/features/subagents/subagent-settings-state.ts';

test('subagent results cannot cross workspace, scope, newer request, or unmount', () => {
  const owner = createSubagentSettingsOwner('/a\0user');
  const initial = owner.begin();
  const saved = owner.begin();
  assert.equal(owner.current(initial), false);
  assert.equal(owner.current(saved), true);
  owner.setScope('/a\0project');
  assert.equal(owner.current(saved), false);
  const project = owner.begin();
  owner.setScope('/b\0project');
  assert.equal(owner.current(project), false);
  const other = owner.begin();
  owner.dispose();
  owner.activate();
  assert.equal(owner.current(other), false);
  assert.equal(owner.current(owner.begin()), true);
});

test('new page reads wait until shared user and project writes finish, in order', async () => {
  const queue = createSubagentSettingsWrites();
  const events = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const user = queue.run(async () => { events.push('user-start'); await held; events.push('user-saved'); });
  const project = queue.run(async () => { events.push('project-saved'); });
  const reopen = queue.wait().then(() => events.push('fresh-read'));
  await Promise.resolve();
  assert.deepEqual(events, ['user-start']);
  release();
  await Promise.all([user, project, reopen]);
  assert.deepEqual(events, ['user-start', 'user-saved', 'project-saved', 'fresh-read']);
});

test('failed write releases remounted reads and does not poison the next save', async () => {
  const queue = createSubagentSettingsWrites();
  await assert.rejects(queue.run(async () => { throw new Error('write failed'); }), /write failed/);
  await queue.wait();
  assert.equal(await queue.run(async () => 'retry saved'), 'retry saved');
});

test('unchecking the last explicit or inherited tool never broadens access through empty inheritance', async () => {
  const { toggleSubagentAllowedTool } = await import('../../web/src/features/subagents/subagent-settings-state.ts');
  assert.equal(toggleSubagentAllowedTool(['read'], ['read', 'write'], 'read'), null);
  assert.equal(toggleSubagentAllowedTool([], ['read'], 'read'), null);
  assert.deepEqual(toggleSubagentAllowedTool([], ['read', 'write'], 'write'), ['read']);
  assert.deepEqual(toggleSubagentAllowedTool(['read'], ['read', 'write'], 'write'), ['read', 'write']);
  assert.deepEqual(toggleSubagentAllowedTool(['unavailable', 'read'], ['read'], 'read'), ['unavailable']);
});
