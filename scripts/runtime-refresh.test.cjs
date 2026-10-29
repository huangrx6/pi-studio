const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createRuntimeRefreshCoordinator,
  registerRuntimeRefreshRequester,
  requestAgentRuntimeRefresh,
} = require('../electron/services/runtime-refresh.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function runtimeSession({ idle = true, waitForIdle } = {}) {
  const session = {
    idle,
    get isIdle() { return session.idle; },
    disposed: false,
    waitForIdle: waitForIdle || (() => Promise.resolve()),
    dispose() { session.disposed = true; },
  };
  return session;
}

test('idle sessions rebuild immediately without disposing the replacement', async () => {
  const current = runtimeSession();
  const replacement = runtimeSession();
  const sessions = new Map([['session-1', current]]);
  const notifications = [];
  let rebuilds = 0;
  const coordinator = createRuntimeRefreshCoordinator({
    sessions,
    rebuild: async () => {
      rebuilds += 1;
      return replacement;
    },
    notify: payload => notifications.push(payload),
  });
  coordinator.markCurrent('session-1');

  const result = await coordinator.request('Agent 工具权限');

  assert.equal(result.status, 'applied');
  assert.equal(result.appliedSessions, 1);
  assert.equal(result.pendingSessions, 0);
  assert.equal(rebuilds, 1);
  assert.equal(sessions.get('session-1'), replacement);
  assert.equal(current.disposed, true);
  assert.equal(replacement.disposed, false);
  assert.equal(notifications.length, 1);
  assert.match(result.message, /运行时已热更新/);
});

test('busy sessions keep the current runtime and refresh after becoming idle', async () => {
  const idleGate = deferred();
  const notification = deferred();
  const current = runtimeSession({ idle: false, waitForIdle: () => idleGate.promise });
  const replacement = runtimeSession();
  const sessions = new Map([['session-1', current]]);
  let rebuilds = 0;
  const coordinator = createRuntimeRefreshCoordinator({
    sessions,
    rebuild: async () => {
      rebuilds += 1;
      return replacement;
    },
    notify: (payload) => {
      if (payload.background) notification.resolve(payload);
    },
  });
  coordinator.markCurrent('session-1');

  const result = await coordinator.request('子 Agent 配置');

  assert.equal(result.status, 'pending');
  assert.equal(result.pendingSessions, 1);
  assert.equal(rebuilds, 0);
  assert.equal(sessions.get('session-1'), current);

  current.idle = true;
  idleGate.resolve();
  const background = await notification.promise;

  assert.equal(background.status, 'applied');
  assert.equal(background.background, true);
  assert.equal(rebuilds, 1);
  assert.equal(sessions.get('session-1'), replacement);
  assert.equal(current.disposed, true);
  assert.match(background.message, /本轮结束后已自动应用/);
});

test('rapid saves coalesce and apply the latest revision once', async () => {
  const idleGate = deferred();
  const notification = deferred();
  const current = runtimeSession({ idle: false, waitForIdle: () => idleGate.promise });
  const sessions = new Map([['session-1', current]]);
  const reasons = [];
  const coordinator = createRuntimeRefreshCoordinator({
    sessions,
    rebuild: async (_id, _current, reason) => {
      reasons.push(reason);
      return runtimeSession();
    },
    notify: (payload) => {
      if (payload.background) notification.resolve(payload);
    },
  });
  coordinator.markCurrent('session-1');

  await coordinator.request('第一次保存');
  await coordinator.request('第二次保存');
  assert.deepEqual(reasons, []);

  current.idle = true;
  idleGate.resolve();
  const background = await notification.promise;

  assert.equal(background.revision, 2);
  assert.deepEqual(reasons, ['第二次保存']);
});

test('ensureFresh rebuilds a session created before the latest save', async () => {
  const sessions = new Map();
  let rebuilds = 0;
  const coordinator = createRuntimeRefreshCoordinator({
    sessions,
    rebuild: async () => {
      rebuilds += 1;
      return runtimeSession();
    },
  });
  const creationRevision = coordinator.currentRevision;
  await coordinator.request('保存新配置');

  const createdFromOldConfig = runtimeSession();
  sessions.set('session-1', createdFromOldConfig);
  coordinator.markCurrent('session-1', creationRevision);
  const fresh = await coordinator.ensureFresh('session-1', createdFromOldConfig);

  assert.equal(rebuilds, 1);
  assert.notEqual(fresh, createdFromOldConfig);
  assert.equal(sessions.get('session-1'), fresh);
  assert.equal(createdFromOldConfig.disposed, true);
});

test('refresh failures are reported and leave the current runtime available', async () => {
  const current = runtimeSession();
  const sessions = new Map([['session-1', current]]);
  const notifications = [];
  const coordinator = createRuntimeRefreshCoordinator({
    sessions,
    rebuild: async () => { throw new Error('tool reload failed'); },
    notify: payload => notifications.push(payload),
  });
  coordinator.markCurrent('session-1');

  const result = await coordinator.request('扩展');

  assert.equal(result.status, 'error');
  assert.equal(result.failedSessions, 1);
  assert.deepEqual(result.errors, ['tool reload failed']);
  assert.equal(sessions.get('session-1'), current);
  assert.equal(current.disposed, false);
  assert.equal(notifications.at(-1).status, 'error');
});

test('IPC callers use the registered session refresh coordinator', async () => {
  const unregister = registerRuntimeRefreshRequester(async reason => ({
    status: 'applied',
    reason,
  }));
  try {
    assert.deepEqual(await requestAgentRuntimeRefresh('MCP 配置'), {
      status: 'applied',
      reason: 'MCP 配置',
    });
  } finally {
    unregister();
  }
  await assert.rejects(() => requestAgentRuntimeRefresh('扩展'), /尚未就绪/);
});
