/**
 * Bounded, renderer-scoped subscriptions for live extension UI data.
 *
 * Providers run in the trusted main process. Declarative data views are
 * normalized as ExtensionContent; sandboxed `panel.view` iframes receive
 * JSON-safe `viewData` snapshots and call generic `invoke(method, params)` RPCs
 * without the host knowing any plugin-specific schema.
 */

const crypto = require('node:crypto');
const {
  MAX_VIEW_PAYLOAD_BYTES,
  normalizeViewMethod,
  sanitizeJsonPayload,
} = require('../core/extension-view.cjs');

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

  snapshot(record, value = record.value, error = undefined) {
    return {
      sourceId: record.sourceId,
      revision: record.revision,
      updatedAt: record.updatedAt,
      ...value,
      ...(error ? { error } : {}),
    };
  }

  normalize(record, value) {
    if (record.view) {
      const payload = value && typeof value === 'object' && Object.hasOwn(value, 'viewData')
        ? value.viewData
        : value;
      return {
        content: [],
        viewData: sanitizeJsonPayload(payload, '插件视图数据', MAX_VIEW_PAYLOAD_BYTES),
        viewInvocable: typeof record.provider.invoke === 'function',
      };
    }
    const content = value?.content ?? value ?? [];
    if (!Array.isArray(content)) {
      throw fail('INVALID_DATA_VIEW', '实时数据源必须返回 ExtensionContent 数组');
    }
    return { content: this.normalizeContentList(content, record.owner, record.normalizeAction, 64) };
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
      ...(typeof record.context?.sessionTitle === 'string' ? { sessionTitle: record.context.sessionTitle } : {}),
      webContentsId: record.targetId,
      signal: record.abortController.signal,
      ...(record.view ? { viewParams: record.viewParams } : {}),
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
    const snapshot = this.snapshot(record, record.pendingValue, record.pendingError);
    record.pendingValue = undefined;
    record.pendingError = undefined;
    record.sentRevision = record.revision;
    record.lastSentAt = this.clock();
    this.emit(record.target, 'pi:extension-data-view', {
      subscriptionId: record.id,
      snapshot,
    });
  }

  schedule(record, value, error) {
    if (record.closed) return;
    record.revision += 1;
    record.updatedAt = this.clock();
    record.pendingValue = value;
    if (!error) record.value = value;
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
    const isGlobalView = payload.view === true && payload.viewScope === 'global';
    const viewParams = payload.view === true
      ? Object.freeze(sanitizeJsonPayload(payload.viewParams ?? {}, '插件查询参数', 64 * 1024) ?? {})
      : undefined;
    const record = {
      id,
      sourceId: payload.sourceId,
      extensionId: payload.extensionId || extensionFromContribution(payload.sourceId),
      target: payload.target,
      targetId: payload.target.id,
      cwd: isGlobalView ? '' : payload.cwd || '',
      sessionId: isGlobalView ? '' : payload.sessionId || '',
      context: !isGlobalView && payload.context && typeof payload.context === 'object'
        ? payload.context
        : undefined,
      owner: payload.owner,
      normalizeAction: payload.normalizeAction,
      provider,
      view: payload.view === true,
      viewScope: payload.viewScope === 'global' ? 'global' : 'session',
      viewParams,
      value: { content: [] },
      pendingValue: undefined,
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
      record.value = this.normalize(record, initial);
      record.updatedAt = this.clock();
      record.lastSentAt = record.updatedAt;
      if (typeof provider.subscribe === 'function') {
        const subscribe = Promise.resolve().then(() => provider.subscribe(
          this.providerContext(record),
          (value) => {
            try {
              this.schedule(record, this.normalize(record, value));
            } catch (error) {
              this.schedule(record, { content: [] }, error instanceof Error ? error.message : String(error));
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
          record.pendingValue ?? record.value,
          record.pendingError,
        ),
      };
    } catch (error) {
      await this.close(id, payload.target);
      throw error;
    }
  }

  async invokeView(id, target, method, params) {
    const record = this.subscriptions.get(id);
    if (!record?.view || record.targetId !== target?.id || typeof record.provider.invoke !== 'function') {
      throw fail('DATA_SOURCE_FORBIDDEN', '当前窗口无权调用这个插件视图');
    }
    const normalizedMethod = normalizeViewMethod(method);
    const normalizedParams = sanitizeJsonPayload(params, '插件调用参数', MAX_VIEW_PAYLOAD_BYTES);
    const result = await this.awaitProvider(() => {
      record.abortController.signal.throwIfAborted();
      return record.provider.invoke(this.providerContext(record), normalizedMethod, normalizedParams);
    }, '调用');
    return sanitizeJsonPayload(result, '插件调用结果', MAX_VIEW_PAYLOAD_BYTES);
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

  async closeAll({ reloading = false } = {}) {
    // Some built-in providers live as long as the desktop process. A workspace
    // registry rebuild must not strand their still-mounted, device-wide controls.
    await this.closeWhere(record => !(reloading && record.owner.scope === 'builtin' && record.provider.retainOnReload?.()));
  }

  async refresh(filter = {}) {
    const sourceId = typeof filter?.sourceId === 'string' ? filter.sourceId.trim() : '';
    const extensionId = typeof filter?.extensionId === 'string' ? filter.extensionId.trim() : '';
    const targets = [...this.subscriptions.values()].filter((record) => {
      if (record.closed) return false;
      if (sourceId && record.sourceId !== sourceId) return false;
      if (extensionId && record.extensionId !== extensionId && !record.sourceId.startsWith(`${extensionId}/`)) {
        return false;
      }
      return true;
    });
    let refreshed = 0;
    await Promise.all(targets.map(async (record) => {
      try {
        const raw = await this.awaitProvider(
          () => record.provider.read(this.providerContext(record)),
          '读取',
        );
        if (record.closed) return;
        const normalized = this.normalize(record, raw);
        record.revision += 1;
        record.updatedAt = this.clock();
        record.value = normalized;
        record.pendingValue = normalized;
        record.pendingError = undefined;
        if (record.timer) clearTimeout(record.timer);
        this.deliver(record);
        refreshed += 1;
      } catch (error) {
        if (record.closed) return;
        this.schedule(record, { content: [] }, error instanceof Error ? error.message : String(error));
      }
    }));
    return refreshed;
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

async function closeAllExtensionDataViewServices(options) {
  await Promise.all([...registeredServices].map((service) => service.closeAll(options)));
}

async function closeExtensionDataViewServices(extensionId) {
  await Promise.all(
    [...registeredServices].map((service) => service.closeExtension(extensionId)),
  );
}

async function closeConversationDataViewServices(ids) {
  const keys = new Set(ids.map(String));
  await Promise.all([...registeredServices].map(service => service.closeWhere(record => (
    keys.has(record.sessionId) || keys.has(String(record.context?.durableSessionId ?? ''))
  ))));
}

async function refreshExtensionDataViews(filter = {}) {
  const counts = await Promise.all([...registeredServices].map((service) => service.refresh(filter)));
  return counts.reduce((sum, count) => sum + count, 0);
}

module.exports = {
  DEFAULT_THROTTLE_MS,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  ExtensionDataViewError,
  ExtensionDataViewService,
  closeAllExtensionDataViewServices,
  closeConversationDataViewServices,
  closeExtensionDataViewServices,
  createExtensionDataViewService,
  refreshExtensionDataViews,
  registerExtensionDataViewService,
};
