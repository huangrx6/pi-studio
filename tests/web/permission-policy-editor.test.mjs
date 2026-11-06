import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPermissionWrites, matchForCondition, permissionDraftError, permissionScopeKey, ruleCondition,
} from '../../web/src/features/permissions/permission-policy-editor.ts';

const policy = (match) => ({ version: 1, preset: 'smart', default: 'ask', tools: {}, rules: [{ id: 'r', label: '发布', decision: 'allow', match }] });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('empty condition remains selected and cannot save or preview as a whole-tool allow', () => {
  for (const condition of ['commandPrefix', 'commandExact', 'pathExact', 'pathGlob']) {
    const match = matchForCondition('bash', condition, '');
    assert.equal(ruleCondition({ match }), condition);
    assert.match(permissionDraftError(policy(match)), /请填写/);
    assert.match(permissionDraftError(policy({ ...match, [condition]: '   ' })), /请填写/);
  }
  assert.equal(permissionDraftError(policy({ tool: 'bash' })), '');
  assert.match(permissionDraftError(policy({ tool: '' })), /工具名称/);
});

test('typing spaces in command conditions preserves input; valid explicit conditions retain semantics', () => {
  const match = matchForCondition('bash', 'commandPrefix', 'git ');
  assert.equal(match.commandPrefix, 'git ');
  assert.equal(permissionDraftError(policy(match)), '');
  assert.deepEqual(matchForCondition('write', 'pathWithin', ''), { tool: 'write', pathWithin: 'workspace' });
  assert.deepEqual(matchForCondition('bash', 'tool', 'old condition'), { tool: 'bash' });
});

test('scope keys use the authoritative owner, never an unrelated session or workspace', () => {
  assert.equal(permissionScopeKey('user', 'a', 'one'), permissionScopeKey('user', 'b', 'two'));
  assert.equal(permissionScopeKey('workspace', 'a', 'one'), permissionScopeKey('workspace', 'a', 'two'));
  assert.notEqual(permissionScopeKey('workspace', 'a', ''), permissionScopeKey('workspace', 'b', ''));
  assert.equal(permissionScopeKey('session', 'a', 'one'), permissionScopeKey('session', 'b', 'one'));
});

test('reopened context waits for a pending ancestor write; unrelated workspace does not wait', async () => {
  const writes = createPermissionWrites();
  const pending = deferred();
  const write = writes.run(permissionScopeKey('workspace', 'a', 'one'), () => pending.promise);
  let loaded = false;
  const load = writes.waitForContext('a', 'two').then(() => { loaded = true; });
  await writes.waitForContext('b', 'two');
  assert.equal(loaded, false);
  await assert.rejects(writes.run(permissionScopeKey('workspace', 'a', 'other'), () => Promise.resolve()), /正在保存/);
  pending.resolve('saved');
  assert.equal(await write, 'saved');
  await load;
  assert.equal(loaded, true);
});

test('global pending writes block all contexts and rejected writes release waiting reloads', async () => {
  const writes = createPermissionWrites();
  const pending = deferred();
  const write = writes.run(permissionScopeKey('user', 'a', ''), () => pending.promise);
  const failure = assert.rejects(write, /disk failed/);
  let loaded = false;
  const load = writes.waitForContext('b', 'other').then(() => { loaded = true; });
  await Promise.resolve();
  assert.equal(loaded, false);
  pending.reject(new Error('disk failed'));
  await failure;
  await load;
  assert.equal(await writes.run(permissionScopeKey('user', '', ''), () => Promise.resolve('retry')), 'retry');
});
