/**
 * Bounded, renderer-scoped subscriptions for live extension UI data.
 *
 * Providers run in the trusted main process. Their output is normalized as the
 * same declarative content accepted from a manifest, throttled, and sent only
 * to the webContents that opened the view. Closing a window, switching
 * workspaces, disabling an extension, or reloading the extension host disposes
 * the provider subscription.
 */

const crypto = require('node:crypto');

const MAX_SUBSCRIPTIONS = 64;
const MAX_PER_RENDERER = 12;
const DEFAULT_THROTTLE_MS = 150;
const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000;
const PROVIDER_CLEANUP_TIMEOUT_MS = 1_000;
const registeredServices = new Set();

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(message)),
      milliseconds,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class ExtensionDataViewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExtensionDataViewError';
    this.code = code;
  }
}

function fail(code, message) {
  return new ExtensionDataViewError(code, message);
}

function extensionFromContribution(sourceId) {
  const slash = sourceId.indexOf('/');
  return slash > 0 ? sourceId.slice(0, slash) : '';
}

class ExtensionDataViewService {
  constructor(options) {
    if (typeof options?.normalizeContentList !== 'function') {
      throw new Error('ExtensionDataViewService 需要 normalizeContentList');
    }
    this.normalizeContentList = options.normalizeContentList;
    this.send = typeof options.send === 'function' ? options.send : undefined;
    this.emit = typeof options.emit === 'function'
      ? options.emit
      : (target, channel, payload) => {
        if (!target || target.isDestroyed?.()) return;
        target.send(channel, payload);
      };
    this.clock = options.clock || Date.now;
    this.throttleMs = Number.isFinite(options.throttleMs)
      ? Math.max(50, Math.min(1_000, options.throttleMs))
      : DEFAULT_THROTTLE_MS;
    this.cleanupTimeoutMs = Number.isFinite(options.cleanupTimeoutMs)
      ? Math.max(20, Math.min(5_000, options.cleanupTimeoutMs))
      : PROVIDER_CLEANUP_TIMEOUT_MS;
    this.providerTimeoutMs = Number.isFinite(options.providerTimeoutMs)
      ? Math.max(20, Math.min(30_000, options.providerTimeoutMs))
      : DEFAULT_PROVIDER_TIMEOUT_MS;
    this.subscriptions = new Map();
  }

  countFor(target) {
    const targetId = target?.id;
    let count = 0;
    for (const item of this.subscriptions.values()) {
      if (item.targetId === targetId) count += 1;
    }
    return count;
  }

  snapshot(record, content = record.content, error = undefined) {
    return {
      sourceId: record.sourceId,
      revision: record.revision,
      updatedAt: record.updatedAt,
      content,
      ...(error ? { error } : {}),
    };
  }

  normalize(record, value) {
    if (!Array.isArray(value)) {
      throw fail('INVALID_DATA_VIEW', '实时数据源必须返回 ExtensionContent 数组');
    }
    return this.normalizeContentList(
      value,
      record.owner,
      record.normalizeAction,
      64,
    );
  }

  providerContext(record) {
    return Object.freeze({
      sourceId: record.sourceId,
      extensionId: record.extensionId,
      cwd: record.cwd,
      sessionId: record.sessionId,
      ...(record.context?.durableSessionId
        ? { durableSessionId: record.context.durableSessionId }
        : {}),
      webContentsId: record.targetId,
      signal: record.abortController.signal,
      ...(record.context?.model
        ? { model: Object.freeze({ ...record.context.model }) }
        : {}),
    });
  }

  awaitProvider(operation, label) {
    return withTimeout(
      Promise.resolve().then(operation),
      this.providerTimeoutMs,
      `实时数据源${label}超时`,
    ).catch((error) => {
      if (error instanceof Error && error.message === `实时数据源${label}超时`) {
        throw fail('DATA_SOURCE_TIMEOUT', error.message);
      }
      throw error;
    });
  }

  deliver(record) {
    if (record.closed) return;
    record.timer = undefined;
    const snapshot = this.snapshot(record, record.pendingContent, record.pendingError);
    record.pendingContent = undefined;
    record.pendingError = undefined;
    record.sentRevision = record.revision;
    record.lastSentAt = this.clock();
    this.emit(record.target, 'pi:extension-data-view', {
      subscriptionId: record.id,
      snapshot,
    });
  }

  schedule(record, content, error) {
    if (record.closed) return;
    record.revision += 1;
    record.updatedAt = this.clock();
    record.pendingContent = content;
    record.pendingError = error;
    const elapsed = record.updatedAt - record.lastSentAt;
    if (elapsed >= this.throttleMs) {
      if (record.timer) clearTimeout(record.timer);
      this.deliver(record);
      return;
    }
    if (record.timer) return;
    record.timer = setTimeout(
      () => this.deliver(record),
      Math.max(1, this.throttleMs - elapsed),
    );
    record.timer.unref?.();
  }

  async open(payload, provider) {
    if (!provider || typeof provider.read !== 'function') {
      throw fail('DATA_SOURCE_UNAVAILABLE', '实时数据源当前不可用');
    }
    if (!payload?.target || payload.target.isDestroyed?.()) {
      throw fail('INVALID_RENDERER', '实时数据源没有有效窗口');
    }
    if (!payload.sourceId || !payload.owner?.manifestId || !payload.owner?.scope) {
      throw fail('INVALID_DATA_VIEW', '实时数据源请求缺少来源信息');
    }
    if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
      throw fail('TOO_MANY_DATA_VIEWS', '实时数据订阅数量已达到上限');
    }
    if (this.countFor(payload.target) >= MAX_PER_RENDERER) {
      throw fail('TOO_MANY_DATA_VIEWS', '当前窗口的实时数据订阅数量已达到上限');
    }
    const id = crypto.randomUUID();
    const now = this.clock();
    const record = {
      id,
      sourceId: payload.sourceId,
      extensionId: payload.extensionId || extensionFromContribution(payload.sourceId),
      target: payload.target,
      targetId: payload.target.id,
      cwd: payload.cwd || '',
      sessionId: payload.sessionId || '',
      context: payload.context && typeof payload.context === 'object'
        ? payload.context
        : undefined,
      owner: payload.owner,
      normalizeAction: payload.normalizeAction,
      provider,
      content: [],
      pendingContent: undefined,
      pendingError: undefined,
      revision: 0,
      sentRevision: -1,
      updatedAt: now,
      lastSentAt: 0,
      timer: undefined,
      closed: false,
      abortController: new AbortController(),
      unsubscribe: undefined,
    };
    this.subscriptions.set(id, record);
    try {
      const initial = await this.awaitProvider(
        () => provider.read(this.providerContext(record)),
        '读取',
      );
      if (record.closed) {
        throw fail('DATA_VIEW_CANCELLED', '实时数据视图已关闭');
      }
      record.content = this.normalize(record, initial?.content ?? initial ?? []);
      record.updatedAt = this.clock();
      record.lastSentAt = record.updatedAt;
      if (typeof provider.subscribe === 'function') {
        const subscribe = Promise.resolve().then(() => provider.subscribe(
          this.providerContext(record),
          (value) => {
            try {
              const content = this.normalize(record, value?.content ?? value ?? []);
              this.schedule(record, content);
            } catch (error) {
              this.schedule(record, [], error instanceof Error ? error.message : String(error));
            }
          },
        ));
        void subscribe.then((unsubscribe) => {
          if (typeof unsubscribe !== 'function') return;
          if (record.closed) {
            void this.disposeProvider(record, unsubscribe);
          } else {
            record.unsubscribe = unsubscribe;
          }
        }, () => {});
        await this.awaitProvider(() => subscribe, '订阅');
        if (record.closed) {
          throw fail('DATA_VIEW_CANCELLED', '实时数据视图已关闭');
        }
      }
      return {
        subscriptionId: id,
        snapshot: this.snapshot(
          record,
          record.pendingContent ?? record.content,
          record.pendingError,
        ),
      };
    } catch (error) {
      await this.close(id, payload.target);
      throw error;
    }
  }

  async disposeProvider(record, pendingUnsubscribe) {
    const unsubscribe = typeof pendingUnsubscribe === 'function'
      ? pendingUnsubscribe
      : record.unsubscribe;
    if (!pendingUnsubscribe) record.unsubscribe = undefined;
    if (typeof unsubscribe !== 'function') return;
    try {
      await withTimeout(
        Promise.resolve().then(() => unsubscribe()),
        this.cleanupTimeoutMs,
        '实时数据源清理超时',
      );
    } catch {
      // Provider cleanup must not prevent the renderer/window from closing.
    }
  }

  async close(id, target) {
    const record = this.subscriptions.get(id);
    if (!record) return { closed: false };
    if (target && record.targetId !== target.id) {
      throw fail('INVALID_SUBSCRIPTION_OWNER', '不能关闭其他窗口的实时数据订阅');
    }
    record.closed = true;
    record.abortController.abort(new Error('实时数据视图已关闭'));
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined;
    this.subscriptions.delete(id);
    await this.disposeProvider(record);
    return { closed: true };
  }

  async closeForRenderer(target) {
    const targetId = target?.id;
    if (targetId === undefined) return;
    const ids = [...this.subscriptions.values()]
      .filter((record) => record.targetId === targetId)
      .map((record) => record.id);
    await Promise.all(ids.map((id) => this.close(id, target)));
  }

  async closeWhere(predicate) {
    const records = [...this.subscriptions.values()].filter(predicate);
    await Promise.all(records.map((record) => this.close(record.id, record.target)));
  }

  async closeExtension(extensionId) {
    await this.closeWhere((record) => record.extensionId === extensionId);
  }

  async closeAll() {
    const records = [...this.subscriptions.values()];
    await Promise.all(records.map((record) => this.close(record.id, record.target)));
  }
}

function createExtensionDataViewService(options) {
  return new ExtensionDataViewService(options);
}

function registerExtensionDataViewService(service) {
  if (!service || typeof service.closeAll !== 'function') {
    throw new Error('无效的实时数据视图服务');
  }
  registeredServices.add(service);
  return () => registeredServices.delete(service);
}

async function closeAllExtensionDataViewServices() {
  await Promise.all([...registeredServices].map((service) => service.closeAll()));
}

async function closeExtensionDataViewServices(extensionId) {
  await Promise.all(
    [...registeredServices].map((service) => service.closeExtension(extensionId)),
  );
}

module.exports = {
  DEFAULT_THROTTLE_MS,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  ExtensionDataViewError,
  ExtensionDataViewService,
  closeAllExtensionDataViewServices,
  closeExtensionDataViewServices,
  createExtensionDataViewService,
  registerExtensionDataViewService,
};
