/**
 * Pi Durable runtime shared by every Studio conversation.
 *
 * The harness is the only agent execution engine. Conversation metadata lives
 * in Studio's SQLite tables while transcripts, tasks, inboxes, usage, and live
 * state are owned by Durable under the `durable_` table prefix.
 */

const {
  closeStudioDatabase,
  databasePath,
  getStudioDatabase,
} = require('../core/studio-db.cjs');
const { getRuntimePolicy } = require('../core/app-settings.cjs');
const {
  closeStudioModelsRuntime,
  getStudioModelsRuntime,
  getStudioModelsRuntimeSync,
} = require('../core/studio-models.cjs');
const { BUILTIN_MANIFESTS, createStudioBuiltins } = require('./studio-builtins.cjs');
const {
  METRICS_EXTENSION_ID,
  METRICS_FOOTER_SOURCE_ID,
  METRICS_SOURCE_ID,
  createMetricsRuntime,
} = require('./metrics-runtime.cjs');
const {
  closeAllExtensionDataViewServices,
} = require('./extension-data-view.cjs');
const { closeMcpRuntime, mcpSnapshot, reloadMcpServers } = require('./mcp-runtime.cjs');
const {
  autoUpdateOfficialExtensions,
  extensionHostSnapshot,
  ensureStudioExtensionIntegrity,
  installBuiltinExtension,
  reloadStudioExtensions,
  uninstallStudioExtensions,
} = require('./studio-extensions.cjs');

const DURABLE_PREFIX = 'durable_';
const DEFAULT_PAGE_SIZE = 500;

let state;
let initialization;

function sanitizedShellEnv() {
  const allowed = new Set([
    'HOME', 'PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM',
  ]);
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key, value]) => value !== undefined && (allowed.has(key) || key.startsWith('XDG_')))
      .map(([key, value]) => [key, value]),
  );
}

/**
 * Durable reads this function at every policy boundary, so saving runtime
 * settings does not require reopening storage or interrupting a run.
 */
function durableHarnessSettings() {
  const policy = getRuntimePolicy();
  return {
    ...(policy.streamTimeoutMs > 0
      ? { stream: { timeoutMs: policy.streamTimeoutMs } }
      : {}),
    retry: {
      enabled: policy.retry.enabled,
      maxRetries: policy.retry.maxRetries,
      baseDelayMs: policy.retry.baseDelayMs,
    },
    compaction: {
      enabled: policy.compaction.enabled,
      reserveTokens: policy.compaction.reserveTokens,
      keepRecentTokens: policy.compaction.keepRecentTokens,
      backgroundTokens: policy.compaction.backgroundTokens,
    },
    progress: {
      partialIntervalMs: 32,
      outputIntervalMs: 48,
    },
    toolExecution: policy.toolExecution,
    contextRetentionMs: policy.contextRetentionMs,
    documentRetentionMs: policy.documentRetentionMs,
    afterFailedRun: policy.afterFailedRun,
    restartLimit: policy.restartLimit,
  };
}

async function createRuntime() {
  const [
    durable,
    chordContext,
    durableTools,
    durableEnv,
    durableSqlite,
    piAi,
    durableToolSearch,
    telemetry,
  ] = await Promise.all([
    import('@earendil-works/pi-durable'),
    import('@earendil-works/chord/context'),
    import('@earendil-works/pi-durable/tools'),
    import('@earendil-works/pi-durable/env/node'),
    import('@earendil-works/pi-durable/storage/sqlite/node'),
    import('@earendil-works/pi-ai'),
    import('@earendil-works/pi-durable/tool-search'),
    import('@earendil-works/pi-telemetry'),
  ]);

  const context = chordContext.BACKGROUND_CONTEXT;
  const db = getStudioDatabase();
  const metricsRuntime = createMetricsRuntime({
    enabled: db.getExtension(METRICS_EXTENSION_ID)?.enabled !== false,
    noopContext: telemetry.NOOP_TELEMETRY_CONTEXT,
    initialMetricRequests: db.listMetricRequests(),
    loadMetricRequests: (conversationId) => db.listMetricRequests({ conversationId }),
    onRequestCompleted: (request) => {
      db.recordUsageRequest(request);
      db.recordMetricRequest(request);
    },
  });
  const registry = durable.createRegistry();
  const builtinExtensions = createStudioBuiltins({
    durable,
    piAi,
    codingTools: durableTools.CodingTools,
    toolSearch: durableToolSearch.createToolSearchExtension(),
    chordContext,
  });

  const storage = await durableSqlite.openNodeSqliteStorage(databasePath(), {
    prefix: DURABLE_PREFIX,
  });
  const shellEnv = sanitizedShellEnv();
  const reports = [];
  const harness = await durable.Harness.open(storage, {
    models: () => {
      const runtime = getStudioModelsRuntimeSync();
      if (!runtime) throw new Error('模型运行时尚未初始化');
      return runtime.models;
    },
    registry,
    identity: {
      userAgent: 'detailed',
      attribution: {
        name: 'Pi Studio',
        url: 'https://github.com/huangrx6/pi-studio',
        categories: ['desktop-agent'],
      },
    },
    settings: durableHarnessSettings,
    telemetry: metricsRuntime.telemetry,
    env: ({ cwd }) => new durableEnv.NodeExecutionEnv({
      cwd: cwd || process.cwd(),
      shellEnv,
    }),
    onReport(error, info) {
      const report = {
        at: Date.now(),
        type: info.type,
        message: error instanceof Error ? error.message : String(error),
        info,
      };
      reports.push(report);
      if (reports.length > 100) reports.shift();
      console.error('[pi-durable]', info.type, report.message);
    },
  }, context);
  harness.resume();
  const runtime = {
    durable,
    storage,
    harness,
    context,
    registry,
    builtinExtensions,
    metricsRuntime,
    extensionDataSources: Object.freeze({
      [METRICS_SOURCE_ID]: metricsRuntime.provider,
      [METRICS_FOOTER_SOURCE_ID]: metricsRuntime.provider,
    }),
    reports,
  };
  for (const manifest of BUILTIN_MANIFESTS) {
    installBuiltinExtension(db, {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      manifest: {
        format: 1,
        ...manifest,
        runtime: { durableEntry: '' },
      },
    });
  }
  const knownBuiltinIds = new Set(BUILTIN_MANIFESTS.map((manifest) => `builtin:${manifest.id}`));
  for (const row of db.listExtensions()) {
    if (row.scope === 'builtin' && !knownBuiltinIds.has(row.id)) {
      db.removeExtension(row.id);
    }
  }
  try {
    runtime.officialExtensionUpdate = await autoUpdateOfficialExtensions();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.officialExtensionUpdate = {
      results: [],
      updated: [],
      error: message,
    };
    console.error('[official-extensions] startup auto-update failed', message);
  }
  await reloadMcpServers(runtime);
  await reloadStudioExtensions(runtime, '');
  syncMetricsExtensionRuntime(runtime);
  return runtime;
}

function syncMetricsExtensionRuntime(runtime) {
  if (!runtime?.metricsRuntime) return;
  const row = getStudioDatabase().getExtension(METRICS_EXTENSION_ID);
  runtime.metricsRuntime.setEnabled(row ? row.enabled === true : true);
}

/**
 * The models callback is synchronous because Durable resolves it on the
 * Session line. Initialization must therefore finish before the harness opens.
 */
async function initializeDurableRuntime() {
  if (state) return state;
  if (initialization) return initialization;
  initialization = (async () => {
    // Initialize Studio's SQLite catalog first so Harness.open() can resolve
    // models synchronously from every Durable task.
    getStudioDatabase();
    await getStudioModelsRuntime();
    state = await createRuntime();
    return state;
  })().finally(() => {
    initialization = undefined;
  });
  return initialization;
}

async function getDurableRuntime() {
  return state || initializeDurableRuntime();
}

async function closeDurableRuntime() {
  const current = state;
  state = undefined;
  try {
    if (!current) return;
    try {
      await closeAllExtensionDataViewServices();
    } finally {
      current.metricsRuntime.close();
      await uninstallStudioExtensions();
      await closeMcpRuntime();
      try {
        await current.harness.close(current.context);
      } finally {
        await current.storage.close(current.context).catch(() => {});
      }
    }
  } finally {
    closeStudioModelsRuntime();
    closeStudioDatabase();
  }
}

async function refreshExtensionRuntime(cwd) {
  const runtime = await getDurableRuntime();
  const mcp = await reloadMcpServers(runtime);
  const studio = await reloadStudioExtensions(runtime, cwd);
  syncMetricsExtensionRuntime(runtime);
  state.workspace = cwd || '';
  return {
    status: 'ready',
    studio,
    mcp,
    refreshedAt: Date.now(),
  };
}

function extensionRuntimeSnapshot() {
  return {
    studio: extensionHostSnapshot(),
    mcp: mcpSnapshot(),
  };
}

async function reconcileRuntimeForWorkspace(cwd, options = {}) {
  const runtime = await getDurableRuntime();
  if (state?.workspace !== cwd) {
    await reloadStudioExtensions(runtime, cwd);
    syncMetricsExtensionRuntime(runtime);
    state.workspace = cwd;
  } else if (options.verifyExtensionIntegrity) {
    await ensureStudioExtensionIntegrity(runtime, cwd);
  }
  return runtime;
}

async function conversationById(id) {
  const runtime = await getDurableRuntime();
  const parsed = Number(id);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return runtime.harness.conversation(parsed, runtime.context);
}

async function readAllEntries(conversation) {
  const runtime = await getDurableRuntime();
  const items = [];
  let cursor;
  do {
    const page = await conversation.entries(
      { order: 'ascending' },
      DEFAULT_PAGE_SIZE,
      cursor,
      runtime.context,
    );
    items.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return items;
}

async function latestEntry(conversation) {
  const runtime = await getDurableRuntime();
  const page = await conversation.entries(
    { order: 'descending' },
    1,
    undefined,
    runtime.context,
  );
  return page.items[0];
}

module.exports = {
  DURABLE_PREFIX,
  closeDurableRuntime,
  conversationById,
  durableHarnessSettings,
  extensionRuntimeSnapshot,
  getDurableRuntime,
  initializeDurableRuntime,
  latestEntry,
  readAllEntries,
  reconcileRuntimeForWorkspace,
  refreshExtensionRuntime,
  sanitizedShellEnv,
  syncMetricsExtensionRuntime,
};
