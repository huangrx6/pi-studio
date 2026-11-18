const { randomUUID } = require('node:crypto');

const STAGE_MESSAGES = {
  trust: '扩展已安装，但旧信任状态尚未完成同步。请重试刷新安装结果。',
  views: '扩展已安装，但扩展界面尚未完成刷新。请重试刷新安装结果。',
  settings: '扩展已安装，但设置与运行时状态尚未完成刷新。请重试刷新安装结果。',
};

/** Opaque, renderer-owned receipts for post-commit work. Never installs on retry. */
function createExtensionInstallRecovery({ revokeTrust, closeViews, readSettings, now = Date.now, token = randomUUID, maxReceipts = 64, ttlMs = 30 * 60_000 }) {
  const receipts = new Map();
  function prune() {
    const timestamp = now();
    for (const [id, record] of receipts) {
      if (!record.pending && record.expiresAt <= timestamp) receipts.delete(id);
    }
  }
  function reserve(ownerId, scope, cwd, trustBaselines) {
    prune();
    if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new Error('扩展安装缺少有效的窗口标识。');
    if (receipts.size >= maxReceipts) {
      for (const [id, record] of receipts) {
        if (!record.pending && record.projection?.status === 'ready') {
          receipts.delete(id);
          break;
        }
      }
    }
    if (receipts.size >= maxReceipts) throw new Error('待恢复的安装操作过多，请先完成刷新或重新启动应用。');
    const id = token();
    const record = { token: id, ownerId, scope, cwd, trustBaselines, expiresAt: now() + ttlMs, pending: null, committed: false, trustDone: false, viewsDone: false, projection: null, installed: null };
    receipts.set(id, record);
    return record;
  }
  function owned(ownerId, id) {
    prune();
    const record = typeof id === 'string' ? receipts.get(id) : undefined;
    if (!record || record.ownerId !== ownerId || !record.committed) {
      throw new Error('安装恢复凭据不可用或已过期。请重新打开扩展设置查看已安装状态，不要重复安装。');
    }
    return record;
  }
  function dto(record) {
    return { committed: true, installed: { ...record.installed }, projection: record.projection, recoveryToken: record.token };
  }
  async function recover(record) {
    let stage = 'trust';
    try {
      if (!record.trustDone) {
        record.installed.trustRevoked = Boolean(await revokeTrust(record));
        record.trustDone = true;
      }
      stage = 'views';
      if (!record.viewsDone) {
        await closeViews(record);
        record.viewsDone = true;
      }
      stage = 'settings';
      record.projection = { status: 'ready', value: await readSettings(record) };
    } catch {
      // Runtime/IO errors may contain filesystem paths or credentials. Return
      // only a fixed recovery instruction, never raw exception text.
      record.projection = { status: 'error', message: STAGE_MESSAGES[stage] };
    }
    return dto(record);
  }
  return {
    install({ ownerId, scope, cwd, trustBaselines, install }) {
      // Capacity failures happen before the irreversible operation begins.
      const record = reserve(ownerId, scope, cwd, trustBaselines);
      record.pending = Promise.resolve().then(async () => {
        let installed;
        try { installed = await install(); }
        catch (cause) { receipts.delete(record.token); throw cause; }
        record.committed = true;
        record.installed = { id: installed.id, version: installed.version, contentChanged: Boolean(installed.contentChanged), trustRevoked: false };
        record.trustBaseline = record.trustBaselines?.get(`${scope}:${installed.id}`);
        delete record.trustBaselines;
        return recover(record);
      }).finally(() => { record.pending = null; });
      return record.pending;
    },
    refresh(ownerId, id) {
      const record = owned(ownerId, id);
      if (record.pending) return record.pending;
      if (record.projection?.status === 'ready') return Promise.resolve(dto(record));
      record.pending = Promise.resolve().then(() => recover(record)).finally(() => { record.pending = null; });
      return record.pending;
    },
    dispose(ownerId, id) {
      // Disposal is idempotent, but another window cannot discard a receipt.
      const record = typeof id === 'string' ? receipts.get(id) : undefined;
      if (!record) return;
      if (record.ownerId !== ownerId) throw new Error('安装恢复凭据不属于当前窗口。');
      receipts.delete(id);
    },
    closeOwner(ownerId) {
      for (const [id, record] of receipts) if (record.ownerId === ownerId) receipts.delete(id);
    },
  };
}

module.exports = { createExtensionInstallRecovery };
