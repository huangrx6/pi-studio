import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillInstallSession } from '../../web/src/features/skills/skill-install-session.ts';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const ready = () => ({ committed: true, installed: { name: 'sample', scope: 'project', version: '1', path: '/B/.pi-studio/skills/sample/SKILL.md', baseDir: '/B/.pi-studio/skills/sample' }, projection: { status: 'ready', value: { scope: '/B' } } });
function harness() {
  const writes = [], reads = [], callbacks = [], commits = [], states = [];
  const session = createSkillInstallSession({
    install(payload) { const pending = deferred(); writes.push({ ...pending, payload }); return pending.promise; },
    refresh(cwd) { const pending = deferred(); reads.push({ ...pending, cwd }); return pending.promise; },
    onCommitted: (value, cwd) => commits.push({ value, cwd }),
    onInstalled(value, cwd) { const pending = deferred(); callbacks.push({ ...pending, value, cwd }); return pending.promise; },
    onChange: state => states.push(state),
  });
  return { session, writes, reads, callbacks, commits, states };
}

test('one token causes one install even with repeated clicks, and reports its fixed original workspace', async () => {
  const h = harness(), pending = h.session.install('token', '/B'); await h.session.install('token', '/C');
  assert.equal(h.writes.length, 1); h.writes[0].resolve(ready()); await flush();
  assert.equal(h.commits.length, 1); assert.equal(h.commits[0].cwd, '/B'); assert.equal(h.callbacks[0].cwd, '/B');
  h.callbacks[0].resolve(); await pending; assert.equal(h.session.state.complete, true); assert.equal(h.session.state.busy, false);
  await h.session.retry(); assert.equal(h.callbacks.length, 1); assert.equal(h.states.filter(state => state.complete).length, 1);
});

test('committed projection failure retries only refresh, then callback; repeated retry is synchronously locked', async () => {
  const h = harness(), result = { ...ready(), projection: { status: 'error', message: 'runtime failed' } };
  const pending = h.session.install('token', '/B'); h.writes[0].resolve(result); await pending;
  assert.equal(h.commits.length, 1); assert.equal(h.reads.length, 0); assert.equal(h.callbacks.length, 0);
  const retry = h.session.retry(); await h.session.retry(); assert.equal(h.reads.length, 1); assert.equal(h.reads[0].cwd, '/B');
  h.reads[0].reject(new Error('still unavailable')); await retry; assert.match(h.session.state.error, /技能已安装，但刷新未完成/);
  const second = h.session.retry(); h.reads[1].resolve({ scope: '/B', fresh: true }); await flush();
  assert.equal(h.callbacks[0].value.projection.value.fresh, true); h.callbacks[0].resolve(); await second;
  assert.equal(h.writes.length, 1); assert.equal(h.commits.length, 1); assert.equal(h.session.state.complete, true);
});

test('callback failures retry only the callback without reinstalling or rereading an already successful projection', async () => {
  const h = harness(), pending = h.session.install('token', '/B'); h.writes[0].resolve(ready()); await flush();
  h.callbacks[0].reject(new Error('parent read failed')); await pending; assert.match(h.session.state.error, /页面更新未完成/);
  const retry = h.session.retry(); assert.equal(h.callbacks.length, 2); assert.equal(h.reads.length, 0);
  h.callbacks[1].resolve(); await retry; assert.equal(h.writes.length, 1); assert.equal(h.commits.length, 1);
});

test('failed installation consumes the renderer token and requires a fresh preview', async () => {
  const h = harness(), pending = h.session.install('token', '/B'); h.writes[0].reject(new Error('staging changed')); await pending;
  assert.match(h.session.state.error, /重新预览/); assert.equal(h.session.state.attempted, true);
  await h.session.install('token', '/B'); await h.session.retry(); assert.equal(h.writes.length, 1); assert.equal(h.reads.length, 0); assert.equal(h.commits.length, 0);
});

test('unmount retains the commit fact with its original scope but suppresses UI callbacks and refresh', async () => {
  const h = harness(), pending = h.session.install('token', '/B'); const states = h.states.length; h.session.dispose();
  h.writes[0].resolve(ready()); await pending; assert.equal(h.states.length, states); assert.equal(h.commits.length, 1); assert.equal(h.commits[0].cwd, '/B'); assert.equal(h.callbacks.length, 0); assert.equal(h.reads.length, 0);
  const next = harness(), installed = next.session.install('token-next', '/C'); next.writes[0].resolve({ ...ready(), projection: { status: 'error', message: 'retry' } }); await installed;
  const retry = next.session.retry(); next.session.dispose(); next.reads[0].resolve({ scope: '/C' }); await retry; assert.equal(next.callbacks.length, 0);
});

test('unmount during the parent callback does not close another dialog or publish an error', async () => {
  for (const reject of [false, true]) {
    const h = harness(), pending = h.session.install('token', '/B'); h.writes[0].resolve(ready()); await flush();
    const count = h.states.length; h.session.dispose(); if (reject) h.callbacks[0].reject(new Error('late')); else h.callbacks[0].resolve();
    await pending; assert.equal(h.states.length, count); assert.equal(h.session.state.complete, false);
  }
});
