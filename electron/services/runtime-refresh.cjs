/**
 * Coordinates runtime rebuilds after configuration changes.
 *
 * A refresh request marks every live session as stale. Idle sessions rebuild
 * immediately; busy sessions keep the runtime used by the active turn and
 * rebuild once `waitForIdle()` settles. Repeated settings changes share one
 * waiter per session and always apply the latest revision.
 */

function errorText(error) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

function statusMessage({
  reason,
  appliedSessions,
  pendingSessions,
  failedSessions,
  background = false,
}) {
  const subject = reason ? `${reason}已保存` : '配置已保存';
  if (failedSessions > 0) {
    if (pendingSessions > 0) return `${subject}；部分运行时已更新，另有会话会在本轮结束后重试。`;
    return `${subject}，但运行时刷新失败。`;
  }
  if (background) return `${reason ? `${reason}已更新` : '配置已更新'}，本轮结束后已自动应用。`;
  if (pendingSessions > 0 && appliedSessions > 0) {
    return `${subject}；空闲会话已更新，运行中的会话会在本轮结束后自动应用。`;
  }
  if (pendingSessions > 0) return `${subject}；当前任务结束后会自动应用，无需重启 App。`;
  if (appliedSessions > 0) return `${subject}，运行时已热更新。`;
  return `${subject}，新会话会自动使用。`;
}

/**
 * IPC 处理模块只需要请求刷新，不应反向依赖会话服务的内部实现。
 * 会话服务启动时注册协调器入口，这样设置和模型模块可以共享同一个接口，
 * 同时避免 CJS 模块之间形成循环引用。
 */
let runtimeRefreshRequester;

function registerRuntimeRefreshRequester(requester) {
  if (typeof requester !== 'function') throw new TypeError('requester must be a function');
  runtimeRefreshRequester = requester;
  return () => {
    if (runtimeRefreshRequester === requester) runtimeRefreshRequester = undefined;
  };
}

async function requestAgentRuntimeRefresh(reason = '配置') {
  if (!runtimeRefreshRequester) throw new Error('Pi 运行时刷新服务尚未就绪');
  return runtimeRefreshRequester(reason);
}

function createRuntimeRefreshCoordinator({
  sessions,
  rebuild,
  notify = () => {},
  isIdle = (session) => Boolean(session?.isIdle),
}) {
  if (!(sessions instanceof Map)) throw new TypeError('sessions must be a Map');
  if (typeof rebuild !== 'function') throw new TypeError('rebuild must be a function');

  let revision = 0;
  let latestReason = '';
  const appliedRevisions = new Map();
  const refreshTasks = new Map();
  const idleWaiters = new Map();

  function markCurrent(sessionId, appliedRevision = revision) {
    appliedRevisions.set(sessionId, Math.min(appliedRevision, revision));
  }

  function forget(sessionId) {
    appliedRevisions.delete(sessionId);
  }

  function isStale(sessionId) {
    return (appliedRevisions.get(sessionId) || 0) < revision;
  }

  function report(payload) {
    try { notify(payload); }
    catch { /* UI notification failure must not roll back saved config */ }
  }

  function summary({
    reason,
    appliedSessions = 0,
    pendingSessions = 0,
    failedSessions = 0,
    errors = [],
    background = false,
    sessionId,
  }) {
    const status = failedSessions > 0
      ? (appliedSessions > 0 || pendingSessions > 0 ? 'partial' : 'error')
      : pendingSessions > 0
        ? (appliedSessions > 0 ? 'partial' : 'pending')
        : appliedSessions > 0
          ? 'applied'
          : 'ready';
    return {
      status,
      revision,
      reason,
      appliedSessions,
      pendingSessions,
      failedSessions,
      sessionId,
      background,
      message: statusMessage({ reason, appliedSessions, pendingSessions, failedSessions, background }),
      errors,
      at: Date.now(),
    };
  }

  async function refreshNow(sessionId, reason = latestReason) {
    const existingTask = refreshTasks.get(sessionId);
    if (existingTask) return existingTask;

    const task = (async () => {
      while (true) {
        const current = sessions.get(sessionId);
        if (!current) return { status: 'skipped', sessionId };
        if (!isIdle(current)) return { status: 'pending', sessionId };
        if (!isStale(sessionId)) return { status: 'applied', sessionId };

        const targetRevision = revision;
        const next = await rebuild(sessionId, current, reason);
        if (sessions.get(sessionId) !== current) {
          try { next?.dispose?.(); } catch { /* replacement runtime is already unusable */ }
          continue;
        }
        sessions.set(sessionId, next);
        appliedRevisions.set(sessionId, targetRevision);
        try { current.dispose?.(); } catch { /* old runtime may already be disposed */ }
        if (!isStale(sessionId)) return { status: 'applied', sessionId };
      }
    })().finally(() => {
      if (refreshTasks.get(sessionId) === task) refreshTasks.delete(sessionId);
    });
    refreshTasks.set(sessionId, task);
    return task;
  }

  function scheduleWhenIdle(sessionId, current, reason = latestReason) {
    if (idleWaiters.has(sessionId) || !current) return idleWaiters.get(sessionId);
    const task = Promise.resolve()
      .then(() => current.waitForIdle())
      .then(async () => {
        idleWaiters.delete(sessionId);
        if (sessions.get(sessionId) !== current || !isStale(sessionId)) return undefined;
        return refreshNow(sessionId, latestReason || reason);
      })
      .then((result) => {
        if (result?.status === 'applied') {
          report(summary({
            reason: latestReason || reason,
            appliedSessions: 1,
            background: true,
            sessionId,
          }));
        }
      })
      .catch((error) => {
        idleWaiters.delete(sessionId);
        report(summary({
          reason: latestReason || reason,
          failedSessions: 1,
          errors: [errorText(error)],
          background: true,
          sessionId,
        }));
      });
    idleWaiters.set(sessionId, task);
    return task;
  }

  async function request(reason = '配置') {
    revision += 1;
    latestReason = reason;
    const immediate = [];
    let pendingSessions = 0;

    for (const [sessionId, current] of [...sessions.entries()]) {
      if (!isIdle(current)) {
        pendingSessions += 1;
        scheduleWhenIdle(sessionId, current, reason);
      } else {
        immediate.push(refreshNow(sessionId, reason));
      }
    }

    const settled = await Promise.allSettled(immediate);
    let appliedSessions = 0;
    let failedSessions = 0;
    const errors = [];
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value?.status === 'applied') appliedSessions += 1;
      else if (result.status === 'fulfilled' && result.value?.status === 'pending') pendingSessions += 1;
      else if (result.status === 'rejected') {
        failedSessions += 1;
        errors.push(errorText(result.reason));
      }
    }

    const result = summary({
      reason,
      appliedSessions,
      pendingSessions,
      failedSessions,
      errors,
    });
    report(result);
    return result;
  }

  async function ensureFresh(sessionId, session) {
    if (!session) return session;
    if (!isStale(sessionId)) return session;
    const task = refreshTasks.get(sessionId);
    if (task) {
      await task;
      return sessions.get(sessionId) || session;
    }
    if (!isIdle(session)) return session;
    const result = await refreshNow(sessionId);
    return result.status === 'applied' ? sessions.get(sessionId) : session;
  }

  return {
    request,
    ensureFresh,
    markCurrent,
    forget,
    isStale,
    get currentRevision() { return revision; },
    get revision() { return revision; },
  };
}

module.exports = {
  createRuntimeRefreshCoordinator,
  errorText,
  registerRuntimeRefreshRequester,
  requestAgentRuntimeRefresh,
  statusMessage,
};
