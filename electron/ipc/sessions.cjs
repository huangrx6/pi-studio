/**
 * Conversation IPC.
 *
 * This is a domain API over Pi Durable rather than a compatibility adapter for
 * the former AgentSession protocol. Renderer clients receive stable DTOs and
 * can always recover from a fresh snapshot after reconnecting.
 */

const { ipcMain, webContents } = require('electron');
const {
  abortConversation,
  composerResources,
  configureConversation,
  conversationAction,
  conversationPage,
  conversationSnapshot,
  createConversation,
  listWorkspaces,
  outline,
  refreshRuntimeState,
  stopConversationWatch,
  submitConversation,
  subscribeConversation,
  taskGraph,
} = require('../services/durable-conversations.cjs');
const {
  executeStudioExtensionCommand,
  extensionDataSource,
  extensionHostSnapshot,
  extensionUiSnapshot,
} = require('../services/studio-extensions.cjs');
const {
  ExtensionDataViewError,
  closeAllExtensionDataViewServices,
  closeExtensionDataViewServices,
  createExtensionDataViewService,
  registerExtensionDataViewService,
} = require('../services/extension-data-view.cjs');
const { normalizeContentList } = require('../services/studio-extension-ui.cjs');
const {
  deleteSubagentChild,
  listSubagentChildren,
  subagentTranscript,
} = require('../services/durable-subagents.cjs');
const {
  getDurableRuntime,
  reconcileRuntimeForWorkspace,
} = require('../services/durable-runtime.cjs');
const { publishMenuBarEvent } = require('../menu-bar-events.cjs');

// `run_end` is also emitted for a user-requested abort. Keep a short-lived
// marker until that terminal event arrives so the menu bar can distinguish a
// cancellation from a completed answer without changing Durable's event ABI.
const cancelledRunIds = new Set();

function closeExtensionDataViews(extensionId) {
  return closeExtensionDataViewServices(extensionId);
}

function closeAllExtensionDataViews() {
  return closeAllExtensionDataViewServices();
}

function contentFreeConversationMetricsEvent(event) {
  if (!event || typeof event !== 'object') return undefined;
  const conversationId = event.conversationId;
  if (event.type === 'snapshot') {
    return {
      type: event.type,
      conversationId,
      payload: { run: Boolean(event.payload?.run) },
    };
  }
  if (event.type === 'usage.updated') {
    return {
      type: event.type,
      conversationId,
      payload: { usage: event.payload?.usage },
    };
  }
  if (['run.started', 'run.completed', 'run.failed'].includes(event.type)) {
    return { type: event.type, conversationId };
  }
  return undefined;
}

function notifyConversationList() {
  for (const target of webContents.getAllWebContents()) {
    if (!target.isDestroyed()) target.send('pi:conversation-list-changed');
  }
}

function closeConversationResource(id, event) {
  const cleanup = () => {
    void stopConversationWatch(id, event.sender.id);
  };
  event.sender.once('destroyed', cleanup);
  return cleanup;
}

function broadcastConversationEvent(event) {
  const metricsEvent = contentFreeConversationMetricsEvent(event);
  if (metricsEvent) {
    void getDurableRuntime()
      .then((runtime) => runtime.metricsRuntime?.recordConversationEvent(metricsEvent))
      .catch(() => {});
  }
  for (const target of webContents.getAllWebContents()) {
    if (!target.isDestroyed()) target.send('pi:conversation-event', event);
  }
  if (event.type === 'run.started') {
    notifyConversationList();
    const id = event.conversationId;
    void conversationSnapshot(id).then((snapshot) => {
      if (snapshot) {
        publishMenuBarEvent({
          type: 'started',
          id,
          title: snapshot.title,
          cwd: snapshot.cwd,
          requestId: snapshot.requestId,
        });
      }
    }).catch(() => {});
  } else if (event.type === 'run.completed' || event.type === 'run.failed') {
    const cancelled = event.type === 'run.completed'
      && cancelledRunIds.delete(event.conversationId);
    publishMenuBarEvent({
      type: 'finished',
      id: event.conversationId,
      status: event.type === 'run.completed'
        ? (cancelled ? 'cancelled' : 'done')
        : 'error',
    });
    notifyConversationList();
  }
}

function registerExtensionDataViewIpc(options = {}) {
  const ipc = options.ipcMain || ipcMain;
  const resolveRuntime = options.resolveRuntime || (async (cwd) => (
    cwd
      ? reconcileRuntimeForWorkspace(cwd)
      : getDurableRuntime()
  ));
  const readHostSnapshot = options.extensionHostSnapshot || extensionHostSnapshot;
  const readDataSource = options.extensionDataSource || extensionDataSource;
  const readConversationSnapshot = options.conversationSnapshot || conversationSnapshot;
  const createService = options.createExtensionDataViewService
    || createExtensionDataViewService;
  const cleanupTargets = new WeakSet();
  let service = options.extensionDataViewService;

  const dataViewService = () => {
    if (!service) {
      service = createService({
        normalizeContentList: (value, owner) => (
          normalizeContentList(value, owner, () => undefined, 64)
        ),
      });
    }
    registerExtensionDataViewService(service);
    return service;
  };

  const cleanWhenDestroyed = (target) => {
    if (!target || typeof target.once !== 'function' || cleanupTargets.has(target)) return;
    cleanupTargets.add(target);
    target.once('destroyed', () => {
      void dataViewService().closeForRenderer(target).catch((error) => {
        console.error('[pi-studio] failed to close extension data view', error);
      });
    });
  };

  ipc.handle('pi:extension-data-view-open', async (event, payload = {}) => {
    const sourceId = typeof payload?.sourceId === 'string'
      ? payload.sourceId.slice(0, 220)
      : '';
    const cwd = typeof payload?.cwd === 'string' ? payload.cwd.slice(0, 4_096) : '';
    const sessionId = typeof payload?.sessionId === 'string'
      ? payload.sessionId.slice(0, 100)
      : '';
    const requestedModelRef = typeof payload?.modelRef === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/\S{1,155}$/.test(payload.modelRef.trim())
      ? payload.modelRef.trim()
      : '';
    if (!sourceId) {
      throw new ExtensionDataViewError('INVALID_DATA_VIEW', '实时数据源 ID 不能为空');
    }

    cleanWhenDestroyed(event.sender);
    const runtime = await resolveRuntime(cwd);
    const row = readHostSnapshot().extensions.find((candidate) => {
      const declared = Array.isArray(candidate.dataSourceIds)
        ? candidate.dataSourceIds
        : (candidate.manifest?.contributes?.dataSources || [])
          .map((source) => `${candidate.id}/${source.id}`);
      return candidate.available && declared.includes(sourceId);
    });
    if (!row) {
      throw new ExtensionDataViewError('DATA_SOURCE_FORBIDDEN', '实时数据源不存在或所属扩展不可用');
    }
    if (!(row.manifest?.permissions || []).includes('ui.data')) {
      throw new ExtensionDataViewError('DATA_SOURCE_FORBIDDEN', '扩展未声明 ui.data 权限');
    }
    const provider = readDataSource(sourceId)
      || (row.scope === 'builtin'
        ? runtime?.extensionDataSources?.[sourceId]
        : undefined);
    if (!provider || typeof provider.read !== 'function') {
      throw new ExtensionDataViewError('DATA_SOURCE_UNAVAILABLE', '实时数据源当前不可用');
    }
    let context;
    if (sessionId) {
      try {
        const conversation = await readConversationSnapshot(sessionId);
        if (conversation?.model) {
          context = {
            durableSessionId: conversation.durableSessionId,
            model: {
              ...conversation.model,
              ...(requestedModelRef ? { modelRef: requestedModelRef } : {}),
            },
          };
        } else if (conversation?.durableSessionId) {
          context = { durableSessionId: conversation.durableSessionId };
        }
      } catch {
        // A newly created conversation may not have a Durable handle yet.
      }
    }
    if (!context && requestedModelRef) {
      context = { model: { modelRef: requestedModelRef } };
    }

    return dataViewService().open({
      sourceId,
      extensionId: row.id,
      target: event.sender,
      cwd,
      sessionId,
      context,
      owner: {
        manifestId: row.manifest.id,
        scope: row.scope,
      },
      normalizeAction: () => undefined,
    }, provider);
  });

  ipc.handle('pi:extension-data-view-close', async (event, subscriptionId) => {
    if (typeof subscriptionId !== 'string' || !subscriptionId) {
      return { closed: false };
    }
    return dataViewService().close(subscriptionId, event.sender);
  });
}

function registerConversationIpc() {
  ipcMain.handle('pi:conversation-list', async () => {
    await refreshRuntimeState();
    return listWorkspaces();
  });

  ipcMain.handle('pi:conversation-create', async (_event, input) => {
    const created = await createConversation(input || {});
    notifyConversationList();
    return created;
  });

  ipcMain.handle('pi:conversation-page', async (_event, { id, limit, cursor } = {}) => (
    conversationPage(id, { limit, cursor })
  ));
  ipcMain.handle('pi:conversation-outline', async (_event, id) => outline(id));
  ipcMain.handle('pi:conversation-snapshot', async (_event, id) => conversationSnapshot(id));

  ipcMain.handle('pi:conversation-subscribe', async (event, id) => {
    const cleanup = closeConversationResource(id, event);
    const snapshot = await subscribeConversation(
      id,
      event.sender.id,
      broadcastConversationEvent,
    );
    if (!snapshot) {
      event.sender.removeListener('destroyed', cleanup);
      throw new Error('会话不存在');
    }
    return snapshot;
  });

  ipcMain.handle('pi:conversation-unsubscribe', async (event, id) => {
    await stopConversationWatch(id, event.sender.id);
    return { ok: true };
  });

  ipcMain.handle('pi:conversation-submit', async (_event, input) => {
    const result = await submitConversation(input || {}, {
      onTitleUpdated: ({ id, title }) => {
        notifyConversationList();
        publishMenuBarEvent({ type: 'title', id, title });
      },
    });
    notifyConversationList();
    return result;
  });

  ipcMain.handle('pi:conversation-configure', async (_event, input) => configureConversation(input || {}));
  ipcMain.handle('pi:conversation-interrupt', async (_event, { id } = {}) => {
    if (typeof id !== 'string' || !id) throw new Error('会话参数无效');
    cancelledRunIds.add(id);
    try {
      const result = await abortConversation(id);
      if (result.wasRunning) {
        // Hide the running item immediately. If the stream event arrives later,
        // the marker above prevents it from being reported as a completion.
        publishMenuBarEvent({ type: 'finished', id, status: 'cancelled' });
        const cleanup = setTimeout(() => cancelledRunIds.delete(id), 15_000);
        cleanup.unref?.();
      } else {
        cancelledRunIds.delete(id);
      }
      notifyConversationList();
      return result;
    } catch (error) {
      cancelledRunIds.delete(id);
      throw error;
    }
  });
  ipcMain.handle('pi:conversation-action', async (_event, input) => {
    const result = await conversationAction(input || {});
    notifyConversationList();
    return result;
  });
  ipcMain.handle('pi:conversation-task-graph', async (_event, id) => taskGraph(id));
  ipcMain.handle('pi:conversation-resources', async (_event, input) => composerResources(input || {}));
  ipcMain.handle('pi:conversation-subagents', async (_event, id) => listSubagentChildren(id));
  ipcMain.handle('pi:conversation-subagent-transcript', async (_event, payload = {}) => (
    subagentTranscript(payload.sessionId, payload.childKey, payload)
  ));
  ipcMain.handle('pi:conversation-subagent-delete', async (_event, payload = {}) => {
    const result = await deleteSubagentChild(payload.sessionId, payload.childKey);
    notifyConversationList();
    return result;
  });

  ipcMain.handle('pi:extensions-ui', async (_event, cwd) => {
    if (typeof cwd === 'string' && cwd) await reconcileRuntimeForWorkspace(cwd);
    return extensionUiSnapshot();
  });
  ipcMain.handle('pi:extensions-command', async (_event, payload = {}) => (
    executeStudioExtensionCommand(payload)
  ));
  registerExtensionDataViewIpc();
}

module.exports = {
  closeAllExtensionDataViews,
  closeExtensionDataViews,
  contentFreeConversationMetricsEvent,
  registerConversationIpc,
  registerExtensionDataViewIpc,
};
