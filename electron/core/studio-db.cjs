/**
 * Pi Studio 的应用数据库。
 *
 * Durable 自己使用 durable_* 表保存会话、任务和文档；这里保存 Studio 的
 * 配置与展示投影。两者位于同一个 SQLite 文件，但使用独立连接：
 * Durable 的异步存储需要自己的连接，Electron 的设置和窗口 API 则需要同步读取。
 * SQLite WAL + busy_timeout 负责协调两个连接。
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  decryptValue,
  encryptValue,
  isEncryptedEnvelope,
} = require('./secure-value.cjs');
const {
  normalizeThinkingLevels,
} = require('./thinking-levels.cjs');

const DATABASE_NAME = 'pi-studio.sqlite';
const SCHEMA_VERSION = 12;
const USAGE_REQUEST_LEDGER_LIMIT = 8_192;
const USAGE_REQUEST_PRUNE_BATCH = 256;
const METRIC_REQUEST_HISTORY_LIMIT = 8;
const REQUEST_TRACE_HISTORY_LIMIT = 48;

function json(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function encode(value) {
  return JSON.stringify(value ?? null);
}

function decodeSecretMap(value) {
  const decoded = decryptValue(json(value, {}));
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return {};
  return Object.fromEntries(
    Object.entries(decoded)
      .filter(([key, entry]) => typeof key === 'string' && typeof entry === 'string'),
  );
}

function encodeSecretMap(value) {
  const normalized = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value)
          .filter(([key, entry]) => typeof key === 'string' && typeof entry === 'string'),
      )
    : {};
  return encode(encryptValue(normalized));
}

function normalizeConversationRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    publicId: row.public_id,
    workspace: row.workspace,
    kind: row.kind,
    title: row.title,
    titleSource: row.title_source,
    goal: row.goal || '',
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRequestId: row.last_request_id || '',
    lastError: row.last_error || '',
  };
}

function normalizeProviderRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    api: row.api,
    icon: row.icon || '',
    modelsUrl: row.models_url || '',
    builtin: Boolean(row.builtin),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeModelRow(row) {
  if (!row) return undefined;
  return {
    providerId: row.provider_id,
    modelId: row.model_id,
    name: row.name,
    api: row.api,
    contextWindow: row.context_window ?? undefined,
    maxTokens: row.max_tokens ?? undefined,
    supportsImages: Boolean(row.supports_images),
    reasoning: Boolean(row.reasoning),
    thinkingLevels: row.thinking_levels === null || row.thinking_levels === undefined
      ? undefined
      : normalizeThinkingLevels(json(row.thinking_levels, []), Boolean(row.reasoning)),
    metadataSource: row.metadata_source || 'legacy',
    enabled: Boolean(row.enabled),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function usageCost(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function usageDay(value, at) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(Number.isFinite(at) ? at : Date.now());
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function normalizeUsageRow(row) {
  if (!row) return undefined;
  const input = tokenCount(row.input_tokens);
  const output = tokenCount(row.output_tokens);
  const cacheRead = tokenCount(row.cache_read_tokens);
  const cacheWrite = tokenCount(row.cache_write_tokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: usageCost(row.cost),
    requests: tokenCount(row.requests),
  };
}

function metricNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeMetricRequestRow(row) {
  if (!row) return undefined;
  return {
    requestId: row.request_id,
    conversationId: row.conversation_id,
    startedAt: Number(row.started_at) || 0,
    finishedAt: Number(row.finished_at) || 0,
    status: row.status === 'failed' ? 'failed' : 'done',
    providerId: row.provider_id || 'unknown',
    modelId: row.model_id || 'unknown',
    tps: metricNumber(row.tps),
    ttftMs: row.ttft_ms === null ? undefined : metricNumber(row.ttft_ms),
    durationMs: metricNumber(row.duration_ms),
    input: tokenCount(row.input_tokens),
    output: tokenCount(row.output_tokens),
    cacheRead: tokenCount(row.cache_read_tokens),
    cacheWrite: tokenCount(row.cache_write_tokens),
    cost: usageCost(row.cost),
  };
}

class StudioDatabase {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.filename = filename;
    this.usageLedgerWrites = 0;
    this.db = new DatabaseSync(filename, { timeout: 5_000 });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  migrate() {
    const current = Number(this.db.prepare('PRAGMA user_version').get().user_version) || 0;
    if (current >= SCHEMA_VERSION) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspaces (
          cwd TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          hidden INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          public_id TEXT NOT NULL UNIQUE,
          workspace TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('conversation', 'durable')),
          title TEXT NOT NULL,
          title_source TEXT NOT NULL DEFAULT 'auto',
          goal TEXT NOT NULL DEFAULT '',
          pinned INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_request_id TEXT NOT NULL DEFAULT '',
          last_error TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS conversations_workspace_idx
          ON conversations(workspace, archived, pinned, updated_at DESC);

        CREATE TABLE IF NOT EXISTS model_providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          api TEXT NOT NULL,
          icon TEXT NOT NULL DEFAULT '',
          models_url TEXT NOT NULL DEFAULT '',
          builtin INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS model_catalog (
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          name TEXT NOT NULL,
          api TEXT NOT NULL,
          context_window INTEGER,
          max_tokens INTEGER,
          supports_images INTEGER NOT NULL DEFAULT 0,
          reasoning INTEGER NOT NULL DEFAULT 0,
          thinking_levels TEXT,
          metadata_source TEXT NOT NULL DEFAULT 'legacy',
          enabled INTEGER NOT NULL DEFAULT 1,
          source TEXT NOT NULL CHECK (source IN ('builtin', 'custom', 'override')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (provider_id, model_id),
          FOREIGN KEY (provider_id) REFERENCES model_providers(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS model_catalog_enabled_idx
          ON model_catalog(enabled, provider_id);

        CREATE TABLE IF NOT EXISTS credentials (
          provider_id TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS turn_diffs (
          conversation_id TEXT NOT NULL,
          at INTEGER NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (conversation_id, at)
        );
        CREATE INDEX IF NOT EXISTS turn_diffs_conversation_idx
          ON turn_diffs(conversation_id, at DESC);

        CREATE TABLE IF NOT EXISTS studio_extensions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          version TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('builtin', 'user', 'project')),
          source TEXT NOT NULL,
          manifest TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          trusted INTEGER NOT NULL DEFAULT 0,
          content_hash TEXT NOT NULL DEFAULT '',
          installed_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS studio_extensions_enabled_idx
          ON studio_extensions(enabled, scope, name);

        CREATE TABLE IF NOT EXISTS mcp_servers (
          name TEXT PRIMARY KEY,
          transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
          command TEXT NOT NULL DEFAULT '',
          args TEXT NOT NULL DEFAULT '[]',
          cwd TEXT NOT NULL DEFAULT '',
          url TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          env TEXT NOT NULL DEFAULT '{}',
          headers TEXT NOT NULL DEFAULT '{}',
          exposure TEXT NOT NULL DEFAULT 'deferred',
          tool_exposure TEXT NOT NULL DEFAULT '{}',
          timeout_seconds INTEGER NOT NULL DEFAULT 60,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_resource_trust (
          workspace TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('skill', 'mcp')),
          resource_path TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          trusted INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace, kind, resource_path)
        );

        CREATE TABLE IF NOT EXISTS usage_request_ledger (
          request_id TEXT PRIMARY KEY,
          recorded_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS usage_request_ledger_time_idx
          ON usage_request_ledger(recorded_at DESC);

        CREATE TABLE IF NOT EXISTS usage_daily (
          day TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cost REAL NOT NULL DEFAULT 0,
          requests INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (day, provider_id, model_id)
        );
        CREATE INDEX IF NOT EXISTS usage_daily_day_idx
          ON usage_daily(day);

        CREATE TABLE IF NOT EXISTS conversation_metric_requests (
          request_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('done', 'failed')),
          provider_id TEXT NOT NULL DEFAULT 'unknown',
          model_id TEXT NOT NULL DEFAULT 'unknown',
          tps REAL NOT NULL DEFAULT 0,
          ttft_ms REAL,
          duration_ms REAL NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cost REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS conversation_metric_requests_conversation_idx
          ON conversation_metric_requests(conversation_id, finished_at DESC);

        CREATE TABLE IF NOT EXISTS conversation_request_traces (
          conversation_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (conversation_id, request_id)
        );
        CREATE INDEX IF NOT EXISTS conversation_request_traces_conversation_idx
          ON conversation_request_traces(conversation_id, created_at DESC);
      `);

      const conversationColumns = new Set(
        this.db.prepare('PRAGMA table_info(conversations)').all().map((row) => row.name),
      );
      if (!conversationColumns.has('public_id')) {
        this.db.exec('ALTER TABLE conversations ADD COLUMN public_id TEXT');
      }
      const conversationIds = this.db.prepare(
        'SELECT id, public_id FROM conversations ORDER BY id',
      ).all();
      const setPublicId = this.db.prepare(
        'UPDATE conversations SET public_id = ? WHERE id = ?',
      );
      for (const row of conversationIds) {
        if (typeof row.public_id !== 'string' || !row.public_id.trim()) {
          row.public_id = randomUUID();
          setPublicId.run(row.public_id, row.id);
        }
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS conversations_public_id_idx
          ON conversations(public_id);
      `);

      // Older development builds keyed turn diffs and session permissions by
      // Durable's internal numeric conversation ID. Preserve them while moving
      // every renderer-facing key to the stable public UUID.
      const moveTurnDiff = this.db.prepare(`
        INSERT OR IGNORE INTO turn_diffs(conversation_id, at, payload)
        SELECT ?, at, payload FROM turn_diffs WHERE conversation_id = ?
      `);
      const deleteOldTurnDiffs = this.db.prepare(
        'DELETE FROM turn_diffs WHERE conversation_id = ?',
      );
      for (const row of conversationIds) {
        if (!row.public_id || row.public_id === row.id) continue;
        moveTurnDiff.run(row.public_id, row.id);
        deleteOldTurnDiffs.run(row.id);
      }
      const policyRow = this.db.prepare(
        "SELECT value FROM settings WHERE key = 'studio.permissions.policy'",
      ).get();
      if (policyRow) {
        const policy = json(policyRow.value, undefined);
        if (policy?.sessions && typeof policy.sessions === 'object') {
          const migrated = {};
          for (const row of conversationIds) {
            if (Object.hasOwn(policy.sessions, row.id)) {
              migrated[row.public_id] = policy.sessions[row.id];
            }
          }
          for (const [key, value] of Object.entries(policy.sessions)) {
            const conversation = conversationIds.find((row) => row.id === key);
            if (!conversation) migrated[key] = value;
          }
          policy.sessions = migrated;
          this.db.prepare(
            'UPDATE settings SET value = ?, updated_at = ? WHERE key = ?',
          ).run(encode(policy), Date.now(), 'studio.permissions.policy');
        }
      }

      // v2 databases already have mcp_servers. Add new columns without
      // rebuilding the table, and migrate plaintext env maps exactly once.
      const columns = new Set(
        this.db.prepare('PRAGMA table_info(mcp_servers)').all().map((row) => row.name),
      );
      const addColumn = (name, definition) => {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE mcp_servers ADD COLUMN ${name} ${definition}`);
      };
      addColumn('headers', "TEXT NOT NULL DEFAULT '{}'");
      addColumn('exposure', "TEXT NOT NULL DEFAULT 'deferred'");
      addColumn('tool_exposure', "TEXT NOT NULL DEFAULT '{}'");
      addColumn('timeout_seconds', 'INTEGER NOT NULL DEFAULT 60');
      addColumn('cwd', "TEXT NOT NULL DEFAULT ''");

      const extensionColumns = new Set(
        this.db.prepare('PRAGMA table_info(studio_extensions)').all().map((row) => row.name),
      );
      if (!extensionColumns.has('content_hash')) {
        this.db.exec("ALTER TABLE studio_extensions ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
        // Trust created by older schemas was not bound to extension code. Project
        // extensions must be reviewed again before the host can load them.
        this.db.exec("UPDATE studio_extensions SET trusted = 0 WHERE scope = 'project'");
      }

      const modelColumns = new Set(
        this.db.prepare('PRAGMA table_info(model_catalog)').all().map((row) => row.name),
      );
      if (!modelColumns.has('thinking_levels')) {
        this.db.exec('ALTER TABLE model_catalog ADD COLUMN thinking_levels TEXT');
      }
      if (!modelColumns.has('metadata_source')) {
        this.db.exec("ALTER TABLE model_catalog ADD COLUMN metadata_source TEXT NOT NULL DEFAULT 'legacy'");
      }

      const legacyUsageRequests = this.db.prepare(`
        SELECT 1 AS found FROM sqlite_master
        WHERE type = 'table' AND name = 'usage_requests'
      `).get();
      if (legacyUsageRequests) {
        this.db.exec(`
          INSERT OR IGNORE INTO usage_request_ledger(request_id, recorded_at)
          SELECT request_id, created_at
          FROM usage_requests
          ORDER BY created_at DESC
          LIMIT ${USAGE_REQUEST_LEDGER_LIMIT};
          DROP TABLE usage_requests;
        `);
      }
      this.pruneUsageRequestLedger();

      const secretRows = this.db.prepare('SELECT name, env, headers FROM mcp_servers').all();
      const updateSecrets = this.db.prepare(
        'UPDATE mcp_servers SET env = ?, headers = ? WHERE name = ?',
      );
      for (const row of secretRows) {
        const rawEnv = json(row.env, {});
        const rawHeaders = json(row.headers, {});
        const env = isEncryptedEnvelope(rawEnv) ? row.env : encodeSecretMap(rawEnv);
        const headers = isEncryptedEnvelope(rawHeaders) ? row.headers : encodeSecretMap(rawHeaders);
        if (env !== row.env || headers !== row.headers) {
          updateSecrets.run(env, headers, row.name);
        }
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = callback();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The callback error remains the useful diagnostic.
      }
      throw error;
    }
  }

  /**
   * Request ids are needed only long enough to suppress a Durable replay. The
   * durable analytics remain as one row per local day and model.
   */
  pruneUsageRequestLedger() {
    this.db.prepare(`
      DELETE FROM usage_request_ledger
      WHERE request_id IN (
        SELECT request_id
        FROM usage_request_ledger
        ORDER BY recorded_at DESC, request_id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(USAGE_REQUEST_LEDGER_LIMIT);
  }

  close() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      this.db.close();
    }
  }

  isOpen() {
    return this.db.isOpen;
  }

  getSetting(key, fallback) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? json(row.value, fallback) : fallback;
  }

  setSetting(key, value) {
    const at = Date.now();
    this.db.prepare(`
      INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, encode(value), at);
    return value;
  }

  deleteSetting(key) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  getSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings ORDER BY key').all();
    return Object.fromEntries(rows.map((row) => [row.key, json(row.value, null)]));
  }

  listWorkspaces() {
    return this.db.prepare(`
      SELECT cwd, name, hidden, position, created_at, updated_at
      FROM workspaces ORDER BY position ASC, name COLLATE NOCASE ASC
    `).all().map((row) => ({
      cwd: row.cwd,
      name: row.name,
      hidden: Boolean(row.hidden),
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getWorkspace(cwd) {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE cwd = ?').get(cwd);
    return row ? {
      cwd: row.cwd,
      name: row.name,
      hidden: Boolean(row.hidden),
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : undefined;
  }

  upsertWorkspace({ cwd, name, hidden, position }) {
    const at = Date.now();
    const current = this.getWorkspace(cwd);
    const next = {
      cwd,
      name: name || current?.name || path.basename(cwd) || cwd,
      hidden: hidden === undefined ? Boolean(current?.hidden) : Boolean(hidden),
      position: position === undefined ? current?.position ?? this.nextWorkspacePosition() : Number(position),
    };
    this.db.prepare(`
      INSERT INTO workspaces(cwd, name, hidden, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(cwd) DO UPDATE SET
        name = excluded.name,
        hidden = excluded.hidden,
        position = excluded.position,
        updated_at = excluded.updated_at
    `).run(next.cwd, next.name, next.hidden ? 1 : 0, next.position, current?.createdAt || at, at);
    return this.getWorkspace(cwd);
  }

  nextWorkspacePosition() {
    return Number(this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS value FROM workspaces').get().value) || 0;
  }

  removeWorkspace(cwd) {
    return this.transaction(() => {
      const count = Number(this.db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE workspace = ?').get(cwd).count);
      if (count > 0) throw new Error('工作区仍有会话，不能删除');
      this.db.prepare('DELETE FROM project_resource_trust WHERE workspace = ?').run(cwd);
      this.removeProjectExtensionsForWorkspace(cwd);
      this.db.prepare('DELETE FROM workspaces WHERE cwd = ?').run(cwd);
    });
  }

  /**
   * Project extension rows are keyed by manifest id, while their source path
   * is the authoritative workspace binding. Remove only rows whose source
   * remains inside this workspace so an unrelated project with a colliding
   * manifest id is never deleted.
   */
  removeProjectExtensionsForWorkspace(cwd) {
    const workspace = path.resolve(cwd);
    const rows = this.db.prepare(
      "SELECT id, source FROM studio_extensions WHERE scope = 'project'",
    ).all();
    const remove = this.db.prepare('DELETE FROM studio_extensions WHERE id = ?');
    const removed = [];
    for (const row of rows) {
      const source = path.resolve(String(row.source || ''));
      const relative = path.relative(workspace, source);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        remove.run(row.id);
        removed.push(row.id);
      }
    }
    return removed;
  }

  listConversations({ includeArchived = true } = {}) {
    const sql = includeArchived
      ? 'SELECT * FROM conversations ORDER BY pinned DESC, updated_at DESC'
      : 'SELECT * FROM conversations WHERE archived = 0 ORDER BY pinned DESC, updated_at DESC';
    return this.db.prepare(sql).all().map(normalizeConversationRow);
  }

  getConversation(id) {
    return normalizeConversationRow(this.db.prepare(
      'SELECT * FROM conversations WHERE id = ? OR public_id = ?',
    ).get(id, id));
  }

  insertConversation(input) {
    const at = input.createdAt || Date.now();
    const publicId = input.publicId || randomUUID();
    this.upsertWorkspace({ cwd: input.workspace });
    this.db.prepare(`
      INSERT INTO conversations(
        id, public_id, workspace, kind, title, title_source, goal, pinned, archived,
        created_at, updated_at, last_request_id, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      publicId,
      input.workspace,
      input.kind,
      input.title || '新会话',
      input.titleSource || 'auto',
      input.goal || '',
      input.pinned ? 1 : 0,
      input.archived ? 1 : 0,
      at,
      input.updatedAt || at,
      input.lastRequestId || '',
      input.lastError || '',
    );
    return this.getConversation(input.id);
  }

  updateConversation(id, patch) {
    const current = this.getConversation(id);
    if (!current) return undefined;
    const next = {
      title: patch.title ?? current.title,
      titleSource: patch.titleSource ?? current.titleSource,
      goal: patch.goal ?? current.goal,
      pinned: patch.pinned ?? current.pinned,
      archived: patch.archived ?? current.archived,
      updatedAt: patch.updatedAt ?? Date.now(),
      lastRequestId: patch.lastRequestId ?? current.lastRequestId,
      lastError: patch.lastError ?? current.lastError,
      kind: patch.kind ?? current.kind,
      workspace: patch.workspace ?? current.workspace,
    };
    this.upsertWorkspace({ cwd: next.workspace });
    this.db.prepare(`
      UPDATE conversations SET
        workspace = ?, kind = ?, title = ?, title_source = ?, goal = ?,
        pinned = ?, archived = ?, updated_at = ?, last_request_id = ?, last_error = ?
      WHERE id = ?
    `).run(
      next.workspace,
      next.kind,
      next.title,
      next.titleSource,
      next.goal,
      next.pinned ? 1 : 0,
      next.archived ? 1 : 0,
      next.updatedAt,
      next.lastRequestId,
      next.lastError,
      current.id,
    );
    return this.getConversation(current.id);
  }

  deleteConversation(id) {
    const current = this.getConversation(id);
    if (!current) return;
    this.transaction(() => {
      this.db.prepare(
        'DELETE FROM turn_diffs WHERE conversation_id = ? OR conversation_id = ?',
      ).run(current.id, current.publicId);
      this.db.prepare(
        'DELETE FROM conversation_metric_requests WHERE conversation_id = ? OR conversation_id = ?',
      ).run(current.id, current.publicId);
      this.db.prepare(
        'DELETE FROM conversation_request_traces WHERE conversation_id = ?',
      ).run(current.id);
      this.db.prepare(
        'DELETE FROM conversation_request_traces WHERE conversation_id = ?',
      ).run(current.publicId);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(current.id);
    });
  }

  /**
   * Resolve a set of Durable roots and every conversation owned below them.
   * Durable has no public delete API, so maintenance operations need this
   * read-only snapshot before they stop work and commit the physical cleanup.
   */
  durableConversationTree(rootIds = [], options = {}) {
    const roots = [...new Set(rootIds
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0))];
    if (roots.length === 0) {
      return {
        conversationIds: [],
        entryIds: [],
        submissionIds: [],
        taskIds: [],
        documentIds: [],
        publicIds: [],
        workspaces: [],
      };
    }
    const hasTable = this.db.prepare(`
      SELECT 1 AS found FROM sqlite_master
      WHERE type = 'table' AND name = 'durable_conversations'
    `).get();
    if (!hasTable) {
      return {
        conversationIds: [],
        entryIds: [],
        submissionIds: [],
        taskIds: [],
        documentIds: [],
        publicIds: [],
        workspaces: [],
      };
    }
    const encodedRoots = JSON.stringify(roots);
    const conversationIds = this.db.prepare(`
      WITH RECURSIVE tree(id) AS (
        SELECT value FROM json_each(?)
        UNION
        SELECT child.id
        FROM durable_conversations AS child
        JOIN tree AS parent ON child.owner_conversation_id = parent.id
      )
      SELECT id FROM tree ORDER BY id
    `).all(encodedRoots).map((row) => Number(row.id));
    const encodedConversations = JSON.stringify(conversationIds);
    const encodedTreeConversations = JSON.stringify(conversationIds);
    const ownerTaskIds = conversationIds.length === 0
      ? []
      : this.db.prepare(`
          SELECT DISTINCT owner_task_id AS id
          FROM durable_conversations
          WHERE id IN (SELECT value FROM json_each(?))
            AND owner_task_id IS NOT NULL
        `).all(encodedTreeConversations).map((row) => Number(row.id));
    const reporterTaskIds = conversationIds.length === 0
      ? []
      : this.db.prepare(`
          SELECT DISTINCT id
          FROM durable_tasks
          WHERE CAST(json_extract(record, '$.input.conversationId') AS INTEGER)
            IN (SELECT value FROM json_each(?))
        `).all(encodedTreeConversations).map((row) => Number(row.id));
    const requestedTaskIds = Array.isArray(options.extraTaskIds)
      ? options.extraTaskIds
      : [];
    const taskIds = [...new Set([
      ...this.db.prepare(`
        SELECT id FROM durable_tasks
        WHERE conversation_id IN (SELECT value FROM json_each(?))
        ORDER BY id
      `).all(encodedConversations).map((row) => Number(row.id)),
      ...ownerTaskIds,
      ...reporterTaskIds,
      ...requestedTaskIds,
    ].map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].sort((left, right) => left - right);
    const entryIds = this.db.prepare(`
      SELECT id FROM durable_entries
      WHERE conversation_id IN (SELECT value FROM json_each(?))
      ORDER BY id
    `).all(encodedConversations).map((row) => Number(row.id));
    const submissionIds = this.db.prepare(`
      SELECT id FROM durable_submissions
      WHERE conversation_id IN (SELECT value FROM json_each(?))
      ORDER BY id
    `).all(encodedConversations).map((row) => Number(row.id));
    const documentIds = this.db.prepare(`
      SELECT id FROM durable_documents
      WHERE (
        scope_kind = 'conversation'
        AND owner_id IN (SELECT value FROM json_each(?))
      ) OR (
        scope_kind = 'task'
        AND owner_id IN (SELECT value FROM json_each(?))
      )
      ORDER BY id
    `).all(encodedConversations, JSON.stringify(taskIds)).map((row) => Number(row.id));
    const studioRows = this.db.prepare(`
      SELECT * FROM conversations
      WHERE CAST(id AS TEXT) IN (
        SELECT CAST(value AS TEXT) FROM json_each(?)
      )
      ORDER BY id
    `).all(encodedConversations).map(normalizeConversationRow);
    return {
      conversationIds,
      entryIds,
      submissionIds,
      taskIds,
      documentIds,
      publicIds: studioRows.map((row) => row.publicId).filter(Boolean),
      workspaces: [...new Set(studioRows.map((row) => row.workspace).filter(Boolean))],
    };
  }

  /**
   * Permanently remove Durable conversation trees and the Studio projection.
   * All dependent records are deleted in one SQLite transaction, while global
   * usage analytics are intentionally retained.
   */
  deleteConversationTrees(rootIds = [], options = {}) {
    return this.transaction(() => {
      const tree = this.durableConversationTree(rootIds, options);
      if (tree.conversationIds.length === 0) return tree;
      const encodedConversations = JSON.stringify(tree.conversationIds);
      const encodedTasks = JSON.stringify(tree.taskIds);
      const encodedDocuments = JSON.stringify(tree.documentIds);
      const encodedRecordIds = JSON.stringify([
        ...tree.conversationIds,
        ...tree.entryIds,
        ...tree.submissionIds,
        ...tree.taskIds,
        ...tree.documentIds,
      ]);
      const studioIds = [...new Set([...tree.conversationIds.map(String), ...tree.publicIds])];
      const encodedStudioIds = JSON.stringify(studioIds);

      this.db.prepare(`
        DELETE FROM durable_document_revisions
        WHERE document_id IN (SELECT value FROM json_each(?))
      `).run(encodedDocuments);
      this.db.prepare(`
        DELETE FROM durable_documents
        WHERE id IN (SELECT value FROM json_each(?))
      `).run(encodedDocuments);
      this.db.prepare(`
        DELETE FROM durable_submissions
        WHERE conversation_id IN (SELECT value FROM json_each(?))
      `).run(encodedConversations);
      this.db.prepare(`
        DELETE FROM durable_tasks
        WHERE id IN (SELECT value FROM json_each(?))
      `).run(encodedTasks);
      this.db.prepare(`
        DELETE FROM durable_entries
        WHERE conversation_id IN (SELECT value FROM json_each(?))
      `).run(encodedConversations);
      this.db.prepare(`
        DELETE FROM durable_conversations
        WHERE id IN (SELECT value FROM json_each(?))
      `).run(encodedConversations);
      this.db.prepare(`
        DELETE FROM durable_record_ids
        WHERE id IN (SELECT value FROM json_each(?))
      `).run(encodedRecordIds);
      this.db.prepare(`
        DELETE FROM turn_diffs
        WHERE conversation_id IN (SELECT value FROM json_each(?))
      `).run(encodedStudioIds);
      this.db.prepare(`
        DELETE FROM conversation_metric_requests
        WHERE conversation_id IN (SELECT value FROM json_each(?))
      `).run(encodedStudioIds);
      this.db.prepare(`
        DELETE FROM conversation_request_traces
        WHERE conversation_id IN (SELECT value FROM json_each(?))
      `).run(encodedStudioIds);
      this.db.prepare(`
        DELETE FROM conversations
        WHERE CAST(id AS TEXT) IN (
          SELECT CAST(value AS TEXT) FROM json_each(?)
        )
      `).run(encodedConversations);
      return tree;
    });
  }

  listProviders() {
    return this.db.prepare('SELECT * FROM model_providers ORDER BY builtin DESC, name COLLATE NOCASE, id').all().map(normalizeProviderRow);
  }

  getProvider(id) {
    return normalizeProviderRow(this.db.prepare('SELECT * FROM model_providers WHERE id = ?').get(id));
  }

  upsertProvider(input) {
    const at = Date.now();
    const current = this.getProvider(input.id);
    const next = {
      id: input.id,
      name: input.name || current?.name || input.id,
      baseUrl: input.baseUrl ?? current?.baseUrl ?? '',
      api: input.api || current?.api || 'openai-completions',
      icon: input.icon ?? current?.icon ?? '',
      modelsUrl: input.modelsUrl ?? current?.modelsUrl ?? '',
      builtin: input.builtin ?? current?.builtin ?? false,
      enabled: input.enabled ?? current?.enabled ?? true,
    };
    this.db.prepare(`
      INSERT INTO model_providers(
        id, name, base_url, api, icon, models_url, builtin, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        base_url = excluded.base_url,
        api = excluded.api,
        icon = excluded.icon,
        models_url = excluded.models_url,
        builtin = excluded.builtin,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      next.id,
      next.name,
      next.baseUrl,
      next.api,
      next.icon,
      next.modelsUrl,
      next.builtin ? 1 : 0,
      next.enabled ? 1 : 0,
      current?.createdAt || at,
      at,
    );
    return this.getProvider(input.id);
  }

  deleteProvider(id) {
    this.transaction(() => {
      // Keep source deletion atomic even when an older database was opened
      // before SQLite foreign-key enforcement was enabled.
      this.db.prepare('DELETE FROM model_catalog WHERE provider_id = ?').run(id);
      this.db.prepare('DELETE FROM credentials WHERE provider_id = ?').run(id);
      this.db.prepare('DELETE FROM model_providers WHERE id = ?').run(id);

      const defaultRef = this.getSetting('studio.models.defaultModelRef', '');
      if (typeof defaultRef === 'string' && defaultRef.startsWith(`${id}/`)) {
        this.deleteSetting('studio.models.defaultModelRef');
      }
      const thinkingByModel = this.getSetting('studio.models.thinkingByModel', {});
      if (thinkingByModel && typeof thinkingByModel === 'object' && !Array.isArray(thinkingByModel)) {
        const next = Object.fromEntries(
          Object.entries(thinkingByModel).filter(([modelRef]) => !modelRef.startsWith(`${id}/`)),
        );
        if (Object.keys(next).length !== Object.keys(thinkingByModel).length) {
          this.setSetting('studio.models.thinkingByModel', next);
        }
      }
    });
  }

  listModels(providerId) {
    const rows = providerId
      ? this.db.prepare('SELECT * FROM model_catalog WHERE provider_id = ? ORDER BY name COLLATE NOCASE, model_id').all(providerId)
      : this.db.prepare('SELECT * FROM model_catalog ORDER BY provider_id, name COLLATE NOCASE, model_id').all();
    return rows.map(normalizeModelRow);
  }

  getModel(providerId, modelId) {
    return normalizeModelRow(this.db.prepare(`
      SELECT * FROM model_catalog WHERE provider_id = ? AND model_id = ?
    `).get(providerId, modelId));
  }

  upsertModel(input) {
    const at = Date.now();
    const current = this.getModel(input.providerId, input.modelId);
    const reasoning = input.reasoning ?? current?.reasoning ?? false;
    const thinkingLevels = input.thinkingLevels === undefined
      ? current?.thinkingLevels
      : normalizeThinkingLevels(input.thinkingLevels, reasoning);
    const next = {
      providerId: input.providerId,
      modelId: input.modelId,
      name: input.name || current?.name || input.modelId,
      api: input.api || current?.api || this.getProvider(input.providerId)?.api || 'openai-completions',
      contextWindow: input.contextWindow ?? current?.contextWindow,
      maxTokens: input.maxTokens ?? current?.maxTokens,
      supportsImages: input.supportsImages ?? current?.supportsImages ?? false,
      reasoning,
      thinkingLevels,
      metadataSource: input.metadataSource || current?.metadataSource || 'manual',
      enabled: input.enabled ?? current?.enabled ?? true,
      source: input.source || current?.source || 'custom',
    };
    this.db.prepare(`
      INSERT INTO model_catalog(
        provider_id, model_id, name, api, context_window, max_tokens,
        supports_images, reasoning, thinking_levels, metadata_source, enabled, source,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, model_id) DO UPDATE SET
        name = excluded.name,
        api = excluded.api,
        context_window = excluded.context_window,
        max_tokens = excluded.max_tokens,
        supports_images = excluded.supports_images,
        reasoning = excluded.reasoning,
        thinking_levels = excluded.thinking_levels,
        metadata_source = excluded.metadata_source,
        enabled = excluded.enabled,
        source = excluded.source,
        updated_at = excluded.updated_at
    `).run(
      next.providerId,
      next.modelId,
      next.name,
      next.api,
      next.contextWindow ?? null,
      next.maxTokens ?? null,
      next.supportsImages ? 1 : 0,
      next.reasoning ? 1 : 0,
      next.thinkingLevels === undefined ? null : encode(next.thinkingLevels),
      next.metadataSource,
      next.enabled ? 1 : 0,
      next.source,
      current?.createdAt || at,
      at,
    );
    return this.getModel(input.providerId, input.modelId);
  }

  deleteModel(providerId, modelId) {
    this.db.prepare('DELETE FROM model_catalog WHERE provider_id = ? AND model_id = ?').run(providerId, modelId);
  }

  setEnabledModels(modelRefs) {
    const enabled = new Set(Array.isArray(modelRefs) ? modelRefs.filter((value) => typeof value === 'string') : []);
    this.transaction(() => {
      const rows = this.db.prepare('SELECT provider_id, model_id FROM model_catalog').all();
      const update = this.db.prepare(`
        UPDATE model_catalog SET enabled = ?, updated_at = ?
        WHERE provider_id = ? AND model_id = ?
      `);
      const at = Date.now();
      for (const row of rows) {
        update.run(enabled.has(`${row.provider_id}/${row.model_id}`) ? 1 : 0, at, row.provider_id, row.model_id);
      }
    });
    return this.listEnabledModels();
  }

  setProviderEnabled(providerId, enabled) {
    this.db.prepare(`
      UPDATE model_providers SET enabled = ?, updated_at = ? WHERE id = ?
    `).run(enabled ? 1 : 0, Date.now(), providerId);
    return this.getProvider(providerId);
  }

  listEnabledModels() {
    return this.listModels().filter((model) => model.enabled && this.getProvider(model.providerId)?.enabled);
  }

  readCredential(providerId) {
    const row = this.db.prepare('SELECT value FROM credentials WHERE provider_id = ?').get(providerId);
    if (!row) return undefined;
    const stored = json(row.value, undefined);
    return isEncryptedEnvelope(stored) ? decryptValue(stored) : stored;
  }

  listCredentials() {
    return this.db.prepare('SELECT provider_id, value FROM credentials ORDER BY provider_id').all()
      .map((row) => {
        const stored = json(row.value, undefined);
        return {
          providerId: row.provider_id,
          credential: isEncryptedEnvelope(stored) ? decryptValue(stored) : stored,
        };
      })
      .filter((row) => row.credential !== undefined);
  }

  writeCredential(providerId, credential) {
    const at = Date.now();
    const encrypted = isEncryptedEnvelope(credential) ? credential : encryptValue(credential);
    this.db.prepare(`
      INSERT INTO credentials(provider_id, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(providerId, encode(encrypted), at);
    return credential;
  }

  deleteCredential(providerId) {
    this.db.prepare('DELETE FROM credentials WHERE provider_id = ?').run(providerId);
  }

  readTurnDiffs(conversationId) {
    const rows = this.db.prepare(`
      SELECT payload FROM turn_diffs WHERE conversation_id = ? ORDER BY at ASC
    `).all(conversationId);
    return rows.map((row) => json(row.payload, null)).filter(Boolean);
  }

  /**
   * Persist a redacted, bounded UI projection of one actual model request.
   * A retry reuses taskId:attempt only when it is the same durable attempt, so
   * an upsert keeps recovery idempotent without collapsing distinct requests.
   */
  saveRequestTrace(conversationId, trace) {
    const key = typeof conversationId === 'string' || typeof conversationId === 'number'
      ? String(conversationId).trim()
      : '';
    const requestId = typeof trace?.requestId === 'string' ? trace.requestId.trim() : '';
    if (!key || !requestId) return false;
    const createdAt = Number.isFinite(trace.createdAt) && trace.createdAt > 0
      ? trace.createdAt
      : Date.now();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO conversation_request_traces(conversation_id, request_id, created_at, payload)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id, request_id) DO UPDATE SET
          created_at = excluded.created_at,
          payload = excluded.payload
      `).run(key, requestId.slice(0, 320), createdAt, encode(trace));
      this.db.prepare(`
        DELETE FROM conversation_request_traces
        WHERE conversation_id = ? AND request_id IN (
          SELECT request_id
          FROM conversation_request_traces
          WHERE conversation_id = ?
          ORDER BY created_at DESC, request_id DESC
          LIMIT -1 OFFSET ?
        )
      `).run(key, key, REQUEST_TRACE_HISTORY_LIMIT);
    });
    return true;
  }

  listRequestTraces(conversationId, { limit = REQUEST_TRACE_HISTORY_LIMIT } = {}) {
    const key = typeof conversationId === 'string' || typeof conversationId === 'number'
      ? String(conversationId)
      : '';
    if (!key) return [];
    const safeLimit = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(limit, REQUEST_TRACE_HISTORY_LIMIT))
      : REQUEST_TRACE_HISTORY_LIMIT;
    return this.db.prepare(`
      SELECT payload
      FROM conversation_request_traces
      WHERE conversation_id = ?
      ORDER BY created_at DESC, request_id DESC
      LIMIT ?
    `).all(key, safeLimit)
      .map((row) => json(row.payload, undefined))
      .filter((trace) => trace && typeof trace === 'object' && !Array.isArray(trace))
      .reverse();
  }

  saveTurnDiff(conversationId, diff) {
    this.db.prepare(`
      INSERT INTO turn_diffs(conversation_id, at, payload) VALUES (?, ?, ?)
      ON CONFLICT(conversation_id, at) DO UPDATE SET payload = excluded.payload
    `).run(conversationId, diff.at, encode(diff));
    this.db.prepare(`
      DELETE FROM turn_diffs
      WHERE conversation_id = ? AND at NOT IN (
        SELECT at FROM turn_diffs WHERE conversation_id = ? ORDER BY at DESC LIMIT 30
      )
    `).run(conversationId, conversationId);
    return diff;
  }

  /**
   * Persist only numeric request telemetry needed to restore the metrics
   * extension after an app restart. Histories are bounded per conversation.
   */
  recordMetricRequest(input = {}) {
    const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
    const conversation = typeof input.conversationId === 'string'
      ? input.conversationId.trim()
      : String(input.conversationId ?? '');
    if (!requestId || !/^\d+$/.test(conversation)) return false;
    const startedAt = Number.isFinite(input.at) ? Number(input.at) : Date.now();
    const durationMs = metricNumber(input.durationMs);
    const finishedAt = Number.isFinite(input.finishedAt)
      ? Number(input.finishedAt)
      : startedAt + durationMs;
    const providerId = typeof input.providerId === 'string' && input.providerId.trim()
      ? input.providerId.trim().slice(0, 160)
      : 'unknown';
    const modelId = typeof input.modelId === 'string' && input.modelId.trim()
      ? input.modelId.trim().slice(0, 240)
      : 'unknown';
    const ttftMs = Number.isFinite(input.ttftMs) && input.ttftMs >= 0
      ? Number(input.ttftMs)
      : null;
    return this.transaction(() => {
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO conversation_metric_requests(
          request_id, conversation_id, started_at, finished_at, status,
          provider_id, model_id, tps, ttft_ms, duration_ms,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        requestId.slice(0, 320),
        conversation,
        startedAt,
        finishedAt,
        input.status === 'failed' ? 'failed' : 'done',
        providerId,
        modelId,
        metricNumber(input.tps),
        ttftMs,
        durationMs,
        tokenCount(input.input),
        tokenCount(input.output),
        tokenCount(input.cacheRead),
        tokenCount(input.cacheWrite),
        usageCost(input.cost),
      );
      if (Number(inserted.changes) === 0) return false;
      this.db.prepare(`
        DELETE FROM conversation_metric_requests
        WHERE conversation_id = ? AND request_id IN (
          SELECT request_id
          FROM conversation_metric_requests
          WHERE conversation_id = ?
          ORDER BY finished_at DESC, request_id DESC
          LIMIT -1 OFFSET ?
        )
      `).run(conversation, conversation, METRIC_REQUEST_HISTORY_LIMIT);
      return true;
    });
  }

  listMetricRequests({ conversationId, limit = 4_096 } = {}) {
    const safeLimit = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(8_192, limit))
      : 4_096;
    const rows = conversationId
      ? this.db.prepare(`
          SELECT * FROM conversation_metric_requests
          WHERE conversation_id = ?
          ORDER BY finished_at DESC, request_id DESC
          LIMIT ?
        `).all(String(conversationId), Math.min(safeLimit, METRIC_REQUEST_HISTORY_LIMIT))
      : this.db.prepare(`
          SELECT * FROM conversation_metric_requests
          ORDER BY finished_at DESC, request_id DESC
          LIMIT ?
        `).all(safeLimit);
    return rows.map(normalizeMetricRequestRow);
  }

  /**
   * Keep durable totals by local day and model. Only a bounded request-id
   * ledger is retained to make replayed Durable completions idempotent.
   */
  recordUsageRequest(input = {}) {
    const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
    if (!requestId) return false;
    const at = Number.isFinite(input.at) ? Number(input.at) : Date.now();
    const day = usageDay(input.day, at);
    const providerId = typeof input.providerId === 'string' && input.providerId.trim()
      ? input.providerId.trim().slice(0, 160)
      : 'unknown';
    const modelId = typeof input.modelId === 'string' && input.modelId.trim()
      ? input.modelId.trim().slice(0, 240)
      : 'unknown';
    const values = {
      input: tokenCount(input.input),
      output: tokenCount(input.output),
      cacheRead: tokenCount(input.cacheRead),
      cacheWrite: tokenCount(input.cacheWrite),
      cost: usageCost(input.cost),
    };
    return this.transaction(() => {
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO usage_request_ledger(request_id, recorded_at)
        VALUES (?, ?)
      `).run(requestId.slice(0, 320), at);
      if (Number(inserted.changes) === 0) return false;
      this.db.prepare(`
        INSERT INTO usage_daily(
          day, provider_id, model_id, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost, requests, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(day, provider_id, model_id) DO UPDATE SET
          input_tokens = usage_daily.input_tokens + excluded.input_tokens,
          output_tokens = usage_daily.output_tokens + excluded.output_tokens,
          cache_read_tokens = usage_daily.cache_read_tokens + excluded.cache_read_tokens,
          cache_write_tokens = usage_daily.cache_write_tokens + excluded.cache_write_tokens,
          cost = usage_daily.cost + excluded.cost,
          requests = usage_daily.requests + 1,
          updated_at = excluded.updated_at
      `).run(
        day,
        providerId,
        modelId,
        values.input,
        values.output,
        values.cacheRead,
        values.cacheWrite,
        values.cost,
        at,
      );
      this.usageLedgerWrites += 1;
      if (this.usageLedgerWrites >= USAGE_REQUEST_PRUNE_BATCH) {
        this.pruneUsageRequestLedger();
        this.usageLedgerWrites = 0;
      }
      return true;
    });
  }

  usageTotals({ sinceDay } = {}) {
    const row = sinceDay
      ? this.db.prepare(`
          SELECT
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
            COALESCE(SUM(cost), 0) AS cost,
            COALESCE(SUM(requests), 0) AS requests,
            COUNT(DISTINCT day) AS active_days
          FROM usage_daily WHERE day >= ?
        `).get(sinceDay)
      : this.db.prepare(`
          SELECT
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
            COALESCE(SUM(cost), 0) AS cost,
            COALESCE(SUM(requests), 0) AS requests,
            COUNT(DISTINCT day) AS active_days
          FROM usage_daily
        `).get();
    return {
      ...normalizeUsageRow(row),
      activeDays: tokenCount(row?.active_days),
    };
  }

  usageDaily({ sinceDay } = {}) {
    const rows = sinceDay
      ? this.db.prepare(`
          SELECT
            day,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens,
            SUM(cost) AS cost,
            SUM(requests) AS requests
          FROM usage_daily
          WHERE day >= ?
          GROUP BY day
          ORDER BY day ASC
        `).all(sinceDay)
      : this.db.prepare(`
          SELECT
            day,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens,
            SUM(cost) AS cost,
            SUM(requests) AS requests
          FROM usage_daily
          GROUP BY day
          ORDER BY day ASC
        `).all();
    return rows.map((row) => ({ day: row.day, ...normalizeUsageRow(row) }));
  }

  usageModels({ sinceDay } = {}) {
    const rows = sinceDay
      ? this.db.prepare(`
          SELECT
            provider_id,
            model_id,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens,
            SUM(cost) AS cost,
            SUM(requests) AS requests
          FROM usage_daily
          WHERE day >= ?
          GROUP BY provider_id, model_id
          ORDER BY input_tokens + output_tokens + cache_read_tokens + cache_write_tokens DESC
        `).all(sinceDay)
      : this.db.prepare(`
          SELECT
            provider_id,
            model_id,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens,
            SUM(cost) AS cost,
            SUM(requests) AS requests
          FROM usage_daily
          GROUP BY provider_id, model_id
          ORDER BY input_tokens + output_tokens + cache_read_tokens + cache_write_tokens DESC
        `).all();
    return rows.map((row) => ({
      providerId: row.provider_id,
      modelId: row.model_id,
      ...normalizeUsageRow(row),
    }));
  }

  usageDailyModels({ sinceDay } = {}) {
    const rows = this.db.prepare(`
      SELECT
        day,
        provider_id,
        model_id,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_write_tokens) AS cache_write_tokens,
        SUM(cost) AS cost,
        SUM(requests) AS requests
      FROM usage_daily
      WHERE day >= ?
      GROUP BY day, provider_id, model_id
      ORDER BY day ASC, provider_id ASC, model_id ASC
    `).all(sinceDay || '0000-00-00');
    return rows.map((row) => ({
      day: row.day,
      providerId: row.provider_id,
      modelId: row.model_id,
      ...normalizeUsageRow(row),
    }));
  }

  listExtensions() {
    return this.db.prepare(`
      SELECT * FROM studio_extensions
      ORDER BY enabled DESC, scope ASC, name COLLATE NOCASE ASC, id
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      scope: row.scope,
      source: row.source,
      manifest: json(row.manifest, {}),
      enabled: Boolean(row.enabled),
      trusted: Boolean(row.trusted),
      contentHash: row.content_hash || '',
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
    }));
  }

  getExtension(id) {
    return this.listExtensions().find((item) => item.id === id);
  }

  upsertExtension(input) {
    const at = Date.now();
    const current = this.getExtension(input.id);
    this.db.prepare(`
      INSERT INTO studio_extensions(
        id, name, version, scope, source, manifest, enabled, trusted, content_hash,
        installed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        version = excluded.version,
        scope = excluded.scope,
        source = excluded.source,
        manifest = excluded.manifest,
        enabled = excluded.enabled,
        trusted = excluded.trusted,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `).run(
      input.id,
      input.name,
      input.version,
      input.scope,
      input.source,
      encode(input.manifest || {}),
      input.enabled === false ? 0 : 1,
      input.trusted ? 1 : 0,
      typeof input.contentHash === 'string' ? input.contentHash : '',
      current?.installedAt || at,
      at,
    );
    return this.getExtension(input.id);
  }

  setExtensionEnabled(id, enabled) {
    this.db.prepare('UPDATE studio_extensions SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id);
    return this.getExtension(id);
  }

  setExtensionTrusted(id, trusted, contentHash) {
    this.db.prepare(`
      UPDATE studio_extensions
      SET trusted = ?, content_hash = ?, updated_at = ?
      WHERE id = ?
    `).run(
      trusted ? 1 : 0,
      typeof contentHash === 'string' ? contentHash : '',
      Date.now(),
      id,
    );
    return this.getExtension(id);
  }

  removeExtension(id) {
    this.db.prepare('DELETE FROM studio_extensions WHERE id = ?').run(id);
  }

  listMcpServers({ includeSecrets = false } = {}) {
    return this.db.prepare('SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE').all().map((row) => {
      const env = decodeSecretMap(row.env);
      const headers = decodeSecretMap(row.headers);
      return {
        name: row.name,
        transport: row.transport,
        command: row.command,
        args: json(row.args, []),
        cwd: row.cwd || '',
        url: row.url,
        description: row.description,
        ...(includeSecrets
          ? { env, headers }
          : {
              envKeys: Object.keys(env).sort(),
              headerKeys: Object.keys(headers).sort(),
            }),
        exposure: ['direct', 'deferred', 'hidden'].includes(row.exposure)
          ? row.exposure
          : 'deferred',
        toolExposure: json(row.tool_exposure, {}),
        timeoutSeconds: Math.max(1, Number(row.timeout_seconds) || 60),
        enabled: Boolean(row.enabled),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  getMcpServer(name, options) {
    return this.listMcpServers(options).find((item) => item.name === name);
  }

  upsertMcpServer(input) {
    const at = Date.now();
    const current = this.getMcpServer(input.name, { includeSecrets: true });
    this.db.prepare(`
      INSERT INTO mcp_servers(
        name, transport, command, args, cwd, url, description, env, headers,
        exposure, tool_exposure, timeout_seconds, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        transport = excluded.transport,
        command = excluded.command,
        args = excluded.args,
        cwd = excluded.cwd,
        url = excluded.url,
        description = excluded.description,
        env = excluded.env,
        headers = excluded.headers,
        exposure = excluded.exposure,
        tool_exposure = excluded.tool_exposure,
        timeout_seconds = excluded.timeout_seconds,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      input.name,
      input.transport,
      input.command || '',
      encode(Array.isArray(input.args) ? input.args : []),
      input.cwd || '',
      input.url || '',
      input.description || '',
      encodeSecretMap(input.env && typeof input.env === 'object' ? input.env : current?.env),
      encodeSecretMap(input.headers && typeof input.headers === 'object' ? input.headers : current?.headers),
      ['direct', 'deferred', 'hidden'].includes(input.exposure) ? input.exposure : 'deferred',
      encode(input.toolExposure && typeof input.toolExposure === 'object' ? input.toolExposure : {}),
      Math.max(1, Math.min(3_600, Number(input.timeoutSeconds) || 60)),
      input.enabled === false ? 0 : 1,
      current?.createdAt || at,
      at,
    );
    return this.getMcpServer(input.name);
  }

  setMcpEnabled(name, enabled) {
    this.db.prepare('UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE name = ?')
      .run(enabled ? 1 : 0, Date.now(), name);
    return this.getMcpServer(name);
  }

  removeMcpServer(name) {
    this.db.prepare('DELETE FROM mcp_servers WHERE name = ?').run(name);
  }

  getProjectResourceTrust(workspace, kind, resourcePath) {
    const row = this.db.prepare(`
      SELECT * FROM project_resource_trust
      WHERE workspace = ? AND kind = ? AND resource_path = ?
    `).get(workspace, kind, resourcePath);
    return row ? {
      workspace: row.workspace,
      kind: row.kind,
      resourcePath: row.resource_path,
      contentHash: row.content_hash,
      trusted: Boolean(row.trusted),
      updatedAt: row.updated_at,
    } : undefined;
  }

  setProjectResourceTrust({ workspace, kind, resourcePath, contentHash, trusted }) {
    const at = Date.now();
    this.db.prepare(`
      INSERT INTO project_resource_trust(
        workspace, kind, resource_path, content_hash, trusted, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace, kind, resource_path) DO UPDATE SET
        content_hash = excluded.content_hash,
        trusted = excluded.trusted,
        updated_at = excluded.updated_at
    `).run(workspace, kind, resourcePath, contentHash, trusted ? 1 : 0, at);
    return this.getProjectResourceTrust(workspace, kind, resourcePath);
  }

  removeProjectResourceTrust(workspace, kind, resourcePath) {
    this.db.prepare(`
      DELETE FROM project_resource_trust
      WHERE workspace = ? AND kind = ? AND resource_path = ?
    `).run(workspace, kind, resourcePath);
  }
}

let instance;

function databasePath() {
  if (process.env.PI_STUDIO_DB) return path.resolve(process.env.PI_STUDIO_DB);
  const { app } = require('electron');
  return path.join(app.getPath('userData'), DATABASE_NAME);
}

function getStudioDatabase() {
  if (instance && !instance.isOpen()) instance = undefined;
  if (!instance) instance = new StudioDatabase(databasePath());
  return instance;
}

function createStudioDatabase(filename) {
  return new StudioDatabase(filename);
}

function closeStudioDatabase() {
  const current = instance;
  instance = undefined;
  if (!current?.isOpen()) return;
  current.close();
}

module.exports = {
  DATABASE_NAME,
  METRIC_REQUEST_HISTORY_LIMIT,
  SCHEMA_VERSION,
  StudioDatabase,
  USAGE_REQUEST_LEDGER_LIMIT,
  closeStudioDatabase,
  createStudioDatabase,
  databasePath,
  getStudioDatabase,
};
