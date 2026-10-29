const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  ExtensionDataViewService,
  closeAllExtensionDataViewServices,
  closeExtensionDataViewServices,
  registerExtensionDataViewService,
} = require('../../electron/services/extension-data-view.cjs');
const {
  registerExtensionDataViewIpc,
} = require('../../electron/ipc/sessions.cjs');

const owner = { manifestId: 'metrics', scope: 'builtin' };
const normalizeAction = () => undefined;
const normalizeContentList = (value) => value;

function target(id = 1) {
  return {
    id,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    send(channel, payload) {
      this.events.push({ channel, payload });
    },
    events: [],
  };
}

function ipcRendererTarget(id = 1) {
  return Object.assign(new EventEmitter(), {
    id,
    destroyed: false,
    events: [],
    isDestroyed() { return this.destroyed; },
    send(channel, payload) {
      this.events.push({ channel, payload });
    },
  });
}

function hostSnapshot({ permission = true, available = true } = {}) {
  const sourceId = 'builtin:studio-metrics/live';
  return {
    extensions: [{
      id: 'builtin:studio-metrics',
      scope: 'builtin',
      available,
      dataSourceIds: [sourceId],
      manifest: {
        id: 'studio-metrics',
        permissions: permission ? ['ui.panels', 'ui.data'] : ['ui.panels'],
        contributes: { dataSources: [{ id: 'live' }] },
      },
    }],
  };
}

test('opens a live data source, throttles updates and cleans up its provider', async () => {
  const renderer = target();
  let publish;
  let disposed = 0;
  const service = new ExtensionDataViewService({
    normalizeContentList,
    emit: (surface, channel, payload) => surface.send(channel, payload),
    throttleMs: 50,
    clock: () => 1_000,
  });
  const opened = await service.open({
    sourceId: 'builtin:studio-metrics/live',
    extensionId: 'builtin:studio-metrics',
    target: renderer,
    owner,
    normalizeAction,
  }, {
    read: async () => [{ kind: 'metric', id: 'tps', label: 'TPS', value: 12 }],
    subscribe: async (_context, emit) => {
      publish = emit;
      return () => { disposed += 1; };
    },
  });

  assert.equal(opened.snapshot.content[0].value, 12);
  publish([{ kind: 'metric', id: 'tps', label: 'TPS', value: 24 }]);
  publish([{ kind: 'metric', id: 'tps', label: 'TPS', value: 36 }]);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(renderer.events.length, 1);
  assert.equal(renderer.events[0].payload.snapshot.content[0].value, 36);

  await service.close(opened.subscriptionId, renderer);
  assert.equal(disposed, 1);
  assert.equal(service.subscriptions.size, 0);
});

test('an initial synchronous provider update is included in the open snapshot', async () => {
  const renderer = target(9);
  const service = new ExtensionDataViewService({
    normalizeContentList,
    emit: (surface, channel, payload) => surface.send(channel, payload),
    throttleMs: 50,
    clock: () => 1_000,
  });
  const opened = await service.open({
    sourceId: 'user:initial/live',
    extensionId: 'user:initial',
    target: renderer,
    owner,
    normalizeAction,
  }, {
    read: async () => [{ kind: 'text', text: 'initial' }],
    subscribe: async (_context, publish) => {
      publish([{ kind: 'text', text: 'synchronous update' }]);
      return () => {};
    },
  });
  assert.equal(opened.snapshot.content[0].text, 'synchronous update');
  await service.close(opened.subscriptionId, renderer);
});

test('a stuck provider cleanup cannot block extension reload or window close', async () => {
  const renderer = target(2);
  const service = new ExtensionDataViewService({
    normalizeContentList,
    emit: (surface, channel, payload) => surface.send(channel, payload),
    cleanupTimeoutMs: 30,
  });
  const opened = await service.open({
    sourceId: 'user:stuck/live',
    extensionId: 'user:stuck',
    target: renderer,
    owner,
    normalizeAction,
  }, {
    read: async () => [],
    subscribe: async () => () => new Promise(() => {}),
  });

  const startedAt = Date.now();
  await service.close(opened.subscriptionId, renderer);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(service.subscriptions.size, 0);
});

test('bounds unresolved provider reads and subscriptions and aborts their signals', async () => {
  const readService = new ExtensionDataViewService({
    normalizeContentList,
    emit: (surface, channel, payload) => surface.send(channel, payload),
    providerTimeoutMs: 25,
  });
  let readSignal;
  const readStartedAt = Date.now();
  await assert.rejects(readService.open({
    sourceId: 'user:read-hang/live',
    extensionId: 'user:read-hang',
    target: target(3),
    owner,
    normalizeAction,
  }, {
    read: async (context) => {
      readSignal = context.signal;
      return new Promise(() => {});
    },
  }), (error) => error.code === 'DATA_SOURCE_TIMEOUT' && /读取超时/.test(error.message));
  assert.ok(Date.now() - readStartedAt < 500);
  assert.equal(readSignal.aborted, true);
  assert.equal(readService.subscriptions.size, 0);

  const subscribeService = new ExtensionDataViewService({
    normalizeContentList,
    emit: (surface, channel, payload) => surface.send(channel, payload),
    providerTimeoutMs: 25,
  });
  let subscribeSignal;
  const subscribeStartedAt = Date.now();
  await assert.rejects(subscribeService.open({
    sourceId: 'user:subscribe-hang/live',
    extensionId: 'user:subscribe-hang',
    target: target(4),
    owner,
    normalizeAction,
  }, {
    read: async () => [],
    subscribe: async (context) => {
      subscribeSignal = context.signal;
      return new Promise(() => {});
    },
  }), (error) => error.code === 'DATA_SOURCE_TIMEOUT' && /订阅超时/.test(error.message));
  assert.ok(Date.now() - subscribeStartedAt < 500);
  assert.equal(subscribeSignal.aborted, true);
  assert.equal(subscribeService.subscriptions.size, 0);
});

test('unsubscribes a subscription that resolves after its open deadline', async () => {
  const renderer = target(5);
  let resolveSubscribe;
  let disposed = 0;
  let signal;
  const service = new ExtensionDataViewService({
    normalizeContentList,
    emit: (surface, channel, payload) => surface.send(channel, payload),
    providerTimeoutMs: 25,
    cleanupTimeoutMs: 50,
  });

  await assert.rejects(service.open({
    sourceId: 'user:late-subscribe/live',
    extensionId: 'user:late-subscribe',
    target: renderer,
    owner,
    normalizeAction,
  }, {
    read: async () => [],
    subscribe: async (context) => {
      signal = context.signal;
      return new Promise((resolve) => {
        resolveSubscribe = resolve;
      });
    },
  }), (error) => error.code === 'DATA_SOURCE_TIMEOUT');

  assert.equal(signal.aborted, true);
  resolveSubscribe(() => { disposed += 1; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(disposed, 1);
  assert.equal(service.subscriptions.size, 0);
});

test('closes every subscription for a destroyed renderer or extension', async () => {
  const first = target(10);
  const second = target(20);
  let disposed = 0;
  const service = new ExtensionDataViewService({
    normalizeContentList,
    emit: (surface, channel, payload) => surface.send(channel, payload),
  });
  const provider = {
    read: async () => [],
    subscribe: async () => () => { disposed += 1; },
  };
  await service.open({
    sourceId: 'builtin:studio-metrics/live',
    extensionId: 'builtin:studio-metrics',
    target: first,
    owner,
    normalizeAction,
  }, provider);
  await service.open({
    sourceId: 'user:other/data',
    extensionId: 'user:other',
    target: second,
    owner,
    normalizeAction,
  }, provider);

  await service.closeForRenderer(first);
  assert.equal(service.subscriptions.size, 1);
  await service.closeExtension('user:other');
  assert.equal(service.subscriptions.size, 0);
  assert.equal(disposed, 2);
});

test('registered services close subscriptions for one extension or all extensions', async () => {
  const first = target(41);
  const second = target(42);
  const disposed = [];
  const firstService = new ExtensionDataViewService({
    normalizeContentList,
    emit: (surface, channel, payload) => surface.send(channel, payload),
  });
  const secondService = new ExtensionDataViewService({
    normalizeContentList,
    emit: (surface, channel, payload) => surface.send(channel, payload),
  });
  const unregisterFirst = registerExtensionDataViewService(firstService);
  const unregisterSecond = registerExtensionDataViewService(secondService);

  try {
    await firstService.open({
      sourceId: 'user:first/live',
      extensionId: 'user:first',
      target: first,
      owner,
      normalizeAction,
    }, {
      read: async () => [],
      subscribe: async () => () => { disposed.push('user:first'); },
    });
    await secondService.open({
      sourceId: 'user:second/live',
      extensionId: 'user:second',
      target: second,
      owner,
      normalizeAction,
    }, {
      read: async () => [],
      subscribe: async () => () => { disposed.push('user:second'); },
    });

    await closeExtensionDataViewServices('user:first');
    assert.equal(firstService.subscriptions.size, 0);
    assert.equal(secondService.subscriptions.size, 1);
    assert.deepEqual(disposed, ['user:first']);

    await closeAllExtensionDataViewServices();
    assert.equal(secondService.subscriptions.size, 0);
    assert.deepEqual(disposed, ['user:first', 'user:second']);
  } finally {
    await Promise.all([firstService.closeAll(), secondService.closeAll()]);
    unregisterFirst();
    unregisterSecond();
  }
});

test('rejects invalid live content and cleans up the partial subscription', async () => {
  const renderer = target();
  let disposed = 0;
  const service = new ExtensionDataViewService({
    normalizeContentList: (value) => {
      if (value[0]?.kind === 'html') throw new Error('unsafe content');
      return value;
    },
    emit: (surface, channel, payload) => surface.send(channel, payload),
  });
  await assert.rejects(service.open({
    sourceId: 'user:unsafe/live',
    extensionId: 'user:unsafe',
    target: renderer,
    owner,
    normalizeAction,
  }, {
    read: async () => [{ kind: 'html' }],
    subscribe: async () => () => { disposed += 1; },
  }), /unsafe content/);
  assert.equal(service.subscriptions.size, 0);
});

test('IPC validates ui.data, opens the runtime provider and closes on renderer destruction', async () => {
  const handlers = new Map();
  const renderer = ipcRendererTarget(31);
  let disposed = 0;
  const provider = {
    read: async () => [{ kind: 'text', text: 'live metrics' }],
    subscribe: async () => () => { disposed += 1; },
  };
  const runtime = {
    extensionDataSources: {
      'builtin:studio-metrics/live': provider,
    },
  };
  registerExtensionDataViewIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    resolveRuntime: async () => runtime,
    extensionHostSnapshot: () => hostSnapshot(),
  });

  const opened = await handlers.get('pi:extension-data-view-open')({
    sender: renderer,
  }, {
    sourceId: 'builtin:studio-metrics/live',
    sessionId: '7',
  });
  assert.equal(opened.snapshot.content[0].text, 'live metrics');
  assert.equal(opened.snapshot.sourceId, 'builtin:studio-metrics/live');

  renderer.destroyed = true;
  renderer.emit('destroyed');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(disposed, 1);
  assert.deepEqual(
    await handlers.get('pi:extension-data-view-close')({
      sender: renderer,
    }, opened.subscriptionId),
    { closed: false },
  );
});

test('IPC forwards the current model and session context into live data providers', async () => {
  const handlers = new Map();
  const renderer = ipcRendererTarget(34);
  let providerContext;
  const provider = {
    async read(context) {
      providerContext = context;
      return [{ kind: 'text', text: context.model?.modelRef || 'no model' }];
    },
    subscribe: async () => () => {},
  };
  registerExtensionDataViewIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    resolveRuntime: async () => ({
      extensionDataSources: {
        'builtin:studio-metrics/live': provider,
      },
    }),
    extensionHostSnapshot: () => hostSnapshot(),
    conversationSnapshot: async () => ({
      id: 'session-context',
      durableSessionId: '42',
      model: {
        modelRef: 'durable/model',
        thinkingLevel: 'high',
      },
    }),
  });

  const opened = await handlers.get('pi:extension-data-view-open')({
    sender: renderer,
  }, {
    sourceId: 'builtin:studio-metrics/live',
    sessionId: 'session-context',
    modelRef: 'openrouter/current-model',
  });
  assert.equal(providerContext.sessionId, 'session-context');
  assert.equal(providerContext.durableSessionId, '42');
  assert.equal(providerContext.model.modelRef, 'openrouter/current-model');
  assert.equal(providerContext.model.thinkingLevel, 'high');
  assert.equal(opened.snapshot.content[0].text, 'openrouter/current-model');
  await handlers.get('pi:extension-data-view-close')({
    sender: renderer,
  }, opened.subscriptionId);
});

test('IPC rejects data sources whose extension lacks ui.data', async () => {
  const handlers = new Map();
  registerExtensionDataViewIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    resolveRuntime: async () => ({
      extensionDataSources: {
        'builtin:studio-metrics/live': {
          read: async () => [],
        },
      },
    }),
    extensionHostSnapshot: () => hostSnapshot({ permission: false }),
  });

  await assert.rejects(
    handlers.get('pi:extension-data-view-open')({
      sender: ipcRendererTarget(32),
    }, {
      sourceId: 'builtin:studio-metrics/live',
    }),
    (error) => error.code === 'DATA_SOURCE_FORBIDDEN' && /ui\.data/.test(error.message),
  );
});

test('IPC prefers the host provider over a colliding runtime fallback', async () => {
  const handlers = new Map();
  const renderer = ipcRendererTarget(33);
  const runtime = {
    extensionDataSources: {
      'builtin:studio-metrics/live': {
        read: async () => [{ kind: 'text', text: 'runtime fallback' }],
      },
    },
  };
  registerExtensionDataViewIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    resolveRuntime: async () => runtime,
    extensionHostSnapshot: () => hostSnapshot(),
    extensionDataSource: (sourceId) => (
      sourceId === 'builtin:studio-metrics/live'
        ? {
          read: async () => [{ kind: 'text', text: 'host provider' }],
        }
        : undefined
    ),
  });

  const opened = await handlers.get('pi:extension-data-view-open')({
    sender: renderer,
  }, {
    sourceId: 'builtin:studio-metrics/live',
    sessionId: '8',
  });
  assert.equal(opened.snapshot.content[0].text, 'host provider');
  await handlers.get('pi:extension-data-view-close')({
    sender: renderer,
  }, opened.subscriptionId);
});
