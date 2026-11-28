/**
 * Pi Durable runtime shared by every Studio conversation.
 *
 * The harness is the only agent execution engine. Conversation metadata lives
 * in Studio's SQLite tables while transcripts, tasks, inboxes, usage, and live
 * state are owned by Durable under the `durable_` table prefix.
 */

const path = require('node:path');
const {
  closeStudioDatabase,
  databasePath,
  getStudioDatabase,
} = require('../core/studio-db.cjs');
const { getRuntimePolicy } = require('../core/app-settings.cjs');
const { openDurableStorage } = require('./durable-storage.cjs');
const { autoCompactOverrides } = require('../core/context-policy.cjs');
const {
  closeStudioModelsRuntime,
  getStudioModelsRuntime,
  getStudioModelsRuntimeSync,
} = require('../core/studio-models.cjs');
const {
  BUILTIN_MANIFESTS,
  createStudioBuiltins,
} = require('./builtin-registry.cjs');
const {
  METRICS_EXTENSION_ID,
  METRICS_FOOTER_SOURCE_ID,
  METRICS_SOURCE_ID,
  createMetricsRuntime,
} = require('../capabilities/metrics/index.cjs');
const { createKeepAwake, createMacLidControl, viewDirectories: keepAwakeViews } = require('../capabilities/keep-awake/index.cjs');
const {
  closeAllExtensionDataViewServices,
} = require('../services/extension-data-view.cjs');
const {
  closeMcpRuntime,
  reloadMcpServers,
} = require('../integrations/mcp/index.cjs');
const {
  autoUpdateOfficialExtensions,
  ensureStudioExtensionIntegrity,
  installBuiltinExtension,
  onStudioExtensionEnabled,
  reloadStudioExtensions,
  uninstallStudioExtensions,
} = require('../services/studio-extensions.cjs');
const {
  cleanupManagedWorktrees,
} = require('../capabilities/subagents/index.cjs');
const { createSecretAwareRegistry } = require('../services/secret-tool-runtime.cjs');
const { publishFileChanges } = require('../services/file-change-events.cjs');

const DURABLE_PREFIX = 'durable_';

let state;
let initialization;

function sanitizedShellEnv() {
  const allowed = new Set([
    'HOME', 'PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM',
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key, value]) => value !== undefined && (allowed.has(key) || key.startsWith('XDG_')))
      .map(([key, value]) => [key, value]),
  );
  try {
    const { pluginPathEnvPrefixes } = require('../services/plugin-distribution.cjs');
    const prefixes = pluginPathEnvPrefixes();
    if (prefixes.length) {
      const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
      const current = env[pathKey] || '';
      env[pathKey] = [...prefixes, current].filter(Boolean).join(path.delimiter);
    }
  } catch {
    // Plugin service optional during early boot / unit isolation.
  }
  return env;
}

/**
 * Durable reads this function at every policy boundary, so saving runtime
 * settings does not require reopening storage or interrupting a run.
 */
function durableHarnessSettings() {
  const policy = getRuntimePolicy();
  // 百分比阈值按每个模型自己的窗口换算成 reserve，Durable 在每次请求边界读取它。
  // 窗口未知的模型继续使用 Harness 的 token 阈值。
  const modelOverrides = policy.compaction.enabled
    ? autoCompactOverrides(getStudioDatabase().listModels(), policy.compaction.autoCompactPercent)
    : {};
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
      ...(Object.keys(modelOverrides).length > 0 ? { modelOverrides } : {}),
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
    piAi,
    durableToolSearch,
    telemetry,
  ] = await Promise.all([
    import('@earendil-works/pi-durable'),
    import('@earendil-works/chord/context'),
    import('@earendil-works/pi-durable/tools'),
    import('@earendil-works/pi-durable/env/node'),
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
      if (db.hasDurableConversation(request.conversationId)) db.recordMetricRequest(request);
    },
  });
  const registry = createSecretAwareRegistry(durable.createRegistry());
  const builtinExtensions = createStudioBuiltins({
    durable,
    observeDesktopRun: (conversationId, observer) => harness.observeDoc(durable.LiveDoc, conversationId, observer, context),
    piAi,
    codingTools: durableTools.CodingTools,
    toolSearch: durableToolSearch.createToolSearchExtension(),
    chordContext,
  });

  const storage = await openDurableStorage(databasePath(), {
    prefix: DURABLE_PREFIX,
    busyTimeoutMs: 15_000,
  });
  const shellEnv = sanitizedShellEnv();
  class StudioExecutionEnv extends durableEnv.NodeExecutionEnv {
    async writeFile(target, content, context) {
      const result = await super.writeFile(target, content, context);
      if (result.ok) {
        const resolved = await this.absolutePath(target, context);
        if (resolved.ok) publishFileChanges([resolved.value], { resolveAliases: true });
      }
      return result;
    }
  }
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
    env: ({ cwd }) => new StudioExecutionEnv({
      cwd: cwd || process.cwd(),
      shellEnv,
    }),
    onReport(report) {
      // 1.5.0：单个 `Report`，按 `kind` 标记（1.4.0 是 `(error, info)`）。
      const entry = {
        at: Date.now(),
        kind: report.kind,
        message: report.error instanceof Error
          ? report.error.message
          : String(report.error),
        report,
      };
      reports.push(entry);
      if (reports.length > 100) reports.shift();
      console.error('[pi-durable]', report.kind, entry.message);
    },
  }, context).catch(async error => {
    metricsRuntime.close();
    await storage.close().catch(() => {});
    throw error;
  });
  const stopAssetArchive = require('../services/conversation-asset-archive.cjs').startAssetArchive(db);
  const { powerSaveBlocker, powerMonitor } = require('electron');
  const keepAwake = createKeepAwake({
    db, blocker: powerSaveBlocker, powerMonitor, onEnabled: onStudioExtensionEnabled,
    createLidControl: process.platform === 'darwin' ? createMacLidControl : undefined,
  });
  keepAwake.addHarness(harness, context);
  harness.resume();
  const runtime = {
    durable,
    cleanupSessionResources: piAi.cleanupSessionResources,
    stopAssetArchive,
    storage,
    harness,
    context,
    registry,
    builtinExtensions,
    builtinViewDirectories: keepAwakeViews,
    keepAwake,
    metricsRuntime,
    extensionDataSources: Object.freeze({
      ...keepAwake.dataSources,
      [METRICS_SOURCE_ID]: metricsRuntime.provider,
      [METRICS_FOOTER_SOURCE_ID]: metricsRuntime.provider,
    }),
    reports,
  };
  try {
    await installRuntimeResources(runtime, db);
    return runtime;
  } catch (error) {
    keepAwake.close();
    await stopAssetArchive();
    metricsRuntime.close();
    await harness.close(context).catch(() => {});
    await storage.close().catch(() => {});
    throw error;
  }
}

async function installRuntimeResources(runtime, db) {
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
  runtime.managedWorktreeCleanup = await cleanupManagedWorktrees()
    .catch((error) => ({
      removed: 0,
      failures: [error instanceof Error ? error.message : String(error)],
    }));
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
    current.keepAwake.close();
    try {
      await closeAllExtensionDataViewServices();
    } finally {
      current.metricsRuntime.close();
      await uninstallStudioExtensions();
      await closeMcpRuntime();
      try {
        await current.harness.close(current.context);
      } finally {
        await current.stopAssetArchive();
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
  durableHarnessSettings,
  getDurableRuntime,
  initializeDurableRuntime,
  latestEntry,
  reconcileRuntimeForWorkspace,
  refreshExtensionRuntime,
  sanitizedShellEnv,
  syncMetricsExtensionRuntime,
};
