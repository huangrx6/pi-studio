import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsDraftGuard } from '../../web/src/shared/settings-draft-guard.ts';

test('guards only unsaved edits; saving one domain does not hide another dirty domain', async () => {
  const guard = createSettingsDraftGuard();
  const profile = { label: '配置', dirty: true, saving: true };
  const policy = { label: '运行策略', dirty: true };
  guard.register(Symbol(), () => profile); guard.register(Symbol(), () => policy);
  assert.deepEqual(guard.labels(), ['运行策略']);
  assert.equal(await guard.canLeave(async labels => { assert.deepEqual(labels, ['运行策略']); return false; }), false);
  assert.deepEqual(guard.labels(), ['运行策略'], 'cancel preserves registration');
  policy.dirty = false;
  assert.equal(await guard.canLeave(async () => { throw new Error('must not prompt'); }), true);
});

test('concurrent navigation cannot replace the first destination or start another prompt', async () => {
  const guard = createSettingsDraftGuard(); guard.register(Symbol(), () => ({ label: '工具', dirty: true }));
  let release; const first = guard.canLeave(() => new Promise(resolve => { release = resolve; }));
  assert.equal(await guard.canLeave(async () => { throw new Error('second prompt'); }), false);
  release(true); assert.equal(await first, true);
  // The caller may still fail to navigate; permission alone must not discard state.
  assert.deepEqual(guard.labels(), ['工具']);
});

test('stale cleanup cannot unregister a replacement owner; unmounted editors no longer block', async () => {
  const guard = createSettingsDraftGuard(); const owner = Symbol();
  const stale = guard.register(owner, () => ({ label: '旧', dirty: true }));
  const current = guard.register(owner, () => ({ label: '新', dirty: true }));
  stale(); assert.deepEqual(guard.labels(), ['新']);
  current(); assert.deepEqual(guard.labels(), []);
  assert.equal(await guard.canLeave(async () => false), true);
});
