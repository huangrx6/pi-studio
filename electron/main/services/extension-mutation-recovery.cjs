const { randomUUID } = require('node:crypto');

const STAGE_MESSAGES = {
  trust: '扩展更改已保存，但旧信任状态尚未完成同步。请重试刷新。',
  views: '扩展更改已保存，但扩展界面尚未完成刷新。请重试刷新。',
  settings: '扩展更改已保存，但设置与运行时状态尚未完成刷新。请重试刷新。',
};

/** Window-owned receipts; retries finish post-commit work, never replay a mutation. */
function createExtensionMutationRecovery({ revokeTrust, closeViews, readSettings, now = Date.now, token = randomUUID, maxReceipts = 64, ttlMs = 30 * 60_000 }) {
  const receipts = new Map();
  function prune() {
    for (const [id, record] of receipts) {
      // An unfinished committed change is still the only safe recovery route.
      // Keep it until recovery, explicit disposal or window destruction; the
      // capacity bound prevents an unbounded accumulation of failed receipts.
      if (!record.pending && (!record.committed || record.projection?.status === 'ready') && record.expiresAt <= now()) receipts.delete(id);
    }
  }
  function reserve(options) {
    prune();
    if (!Number.isSafeInteger(options.ownerId) || options.ownerId < 1) throw new Error('扩展更改缺少有效的窗口标识。');
    if (receipts.size >= maxReceipts) {
      for (const [id, record] of receipts) {
        if (!record.pending && record.projection?.status === 'ready') { receipts.delete(id); break; }
      }
    }
    if (receipts.size >= maxReceipts) throw new Error('待恢复的扩展更改过多，请先完成刷新。');
    const record = {
      token: token(), ownerId: options.ownerId, id: options.id, action: options.action,
      scope: options.scope, cwd: options.cwd, trustBaseline: options.trustBaseline,
      needsCloseViews: options.needsCloseViews, expiresAt: now() + ttlMs,
      pending: null, committed: false, trustDone: false, viewsDone: false, installed: null, projection: null,
    };
    receipts.set(record.token, record);
    return record;
  }
  function owned(ownerId, token) {
    prune();
    const record = typeof token === 'string' ? receipts.get(token) : undefined;
    if (!record || record.ownerId !== ownerId || !record.committed) {
      throw new Error('扩展更改恢复凭据不可用或已过期。请重新打开扩展设置查看状态，不要重复执行更改。');
    }
    return record;
  }
  function dto(record) {
    return {
      committed: true, recoveryToken: record.token, projection: record.projection,
      ...(record.installed ? { installed: { ...record.installed } } : {}),
    };
  }
  async function recover(record) {
    let stage = 'trust';
    try {
      if (!record.trustDone) {
        if (record.action === 'rollback') record.installed.trustRevoked = Boolean(await revokeTrust(record));
        record.trustDone = true;
      }
      stage = 'views';
      if (!record.viewsDone) {
        if (record.needsCloseViews) await closeViews(record);
        record.viewsDone = true;
      }
      stage = 'settings';
      record.projection = { status: 'ready', value: await readSettings(record) };
    } catch {
      record.projection = { status: 'error', message: STAGE_MESSAGES[stage] };
    }
    return dto(record);
  }
  return {
    mutate(options) {
      const record = reserve(options);
      record.pending = Promise.resolve().then(async () => {
        let result;
        try { result = await options.mutate(); }
        catch (cause) { receipts.delete(record.token); throw cause; }
        record.committed = true;
        record.expiresAt = now() + ttlMs;
        if (record.action === 'rollback') {
          record.installed = { id: result.id, version: result.version, contentChanged: Boolean(result.contentChanged), trustRevoked: false };
        }
        return recover(record);
      }).finally(() => { record.pending = null; });
      return record.pending;
    },
    refresh(ownerId, token) {
      const record = owned(ownerId, token);
      if (record.pending) return record.pending;
      if (record.projection?.status === 'ready') return Promise.resolve(dto(record));
      record.pending = Promise.resolve().then(() => recover(record)).finally(() => { record.pending = null; });
      return record.pending;
    },
    dispose(ownerId, token) {
      const record = typeof token === 'string' ? receipts.get(token) : undefined;
      if (!record) return;
      if (record.ownerId !== ownerId) throw new Error('扩展更改恢复凭据不属于当前窗口。');
      receipts.delete(token);
    },
    closeOwner(ownerId) {
      for (const [id, record] of receipts) if (record.ownerId === ownerId) receipts.delete(id);
    },
  };
}

module.exports = { createExtensionMutationRecovery };
