const path = require('node:path');

const addDailyUsage = `
  INSERT INTO usage_daily(workspace, day, provider_id, model_id, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, cost, requests, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT(workspace, day, provider_id, model_id) DO UPDATE SET
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    cost = cost + excluded.cost,
    requests = requests + 1,
    updated_at = MAX(updated_at, excluded.updated_at)
`;

// A hidden worktree still appears in the workspace list while it has conversations.
const activeProjectIds = 'SELECT cwd FROM workspaces WHERE hidden = 0 UNION SELECT workspace FROM conversations';

function usageWorkspace(db, conversationId) {
  if (!conversationId) return '';
  const id = String(conversationId);
  const direct = db.prepare('SELECT workspace FROM conversations WHERE id = ? OR public_id = ?').get(id, id);
  if (direct) return direct.workspace;
  if (!/^\d+$/.test(id) || !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'durable_conversations'").get()) return '';
  // A child agent can have only a Durable row. Its owning Studio conversation supplies the project.
  return db.prepare(`
    WITH RECURSIVE owners(id) AS (
      SELECT CAST(? AS INTEGER)
      UNION SELECT c.owner_conversation_id FROM durable_conversations c JOIN owners ON c.id = owners.id
        WHERE c.owner_conversation_id IS NOT NULL
    )
    SELECT c.workspace FROM owners JOIN conversations c ON c.id = CAST(owners.id AS TEXT) LIMIT 1
  `).get(id)?.workspace || '';
}

function listUsageProjects(db) {
  return db.prepare(`
    WITH active(cwd) AS (${activeProjectIds}),
    projects(cwd) AS (SELECT cwd FROM active UNION SELECT workspace FROM usage_daily)
    SELECT p.cwd AS workspace, COALESCE(w.name, n.name) AS name,
      (a.cwd IS NULL AND p.cwd <> '') AS removed
    FROM projects p LEFT JOIN active a ON a.cwd = p.cwd
    LEFT JOIN workspaces w ON w.cwd = p.cwd LEFT JOIN usage_project_names n ON n.workspace = p.cwd
    ORDER BY (p.cwd = ''), removed, name COLLATE NOCASE, p.cwd
  `).all().map(row => ({
    workspace: row.workspace,
    name: row.workspace ? row.name || path.basename(row.workspace) || row.workspace : '未归属用量',
    removed: Boolean(row.removed),
  }));
}

function migrateUsageProjects(db) {
  db.exec('CREATE TABLE IF NOT EXISTS usage_project_names (workspace TEXT PRIMARY KEY, name TEXT NOT NULL)');
  const columns = db.prepare('PRAGMA table_info(usage_daily)').all();
  if (columns.some(column => column.name === 'workspace')) return;
  if (columns.length) db.exec('ALTER TABLE usage_daily RENAME TO usage_daily_v19; DROP INDEX IF EXISTS usage_daily_day_idx');
  db.exec(`
    CREATE TABLE usage_daily (
      workspace TEXT NOT NULL, day TEXT NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace, day, provider_id, model_id)
    );
    CREATE INDEX usage_daily_day_idx ON usage_daily(day);
  `);
  if (!columns.length) return;
  db.exec(`
    INSERT INTO usage_daily SELECT '', day, provider_id, model_id, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, cost, requests, updated_at FROM usage_daily_v19;
    DROP TABLE usage_daily_v19;
  `);
  // Move only requests retained in both ledgers, and only out of a matching aggregate.
  // The unattributed remainder keeps its original day, model and cost.
  const verified = db.prepare(`
    SELECT m.*, date(m.started_at / 1000, 'unixepoch', 'localtime') AS day FROM conversation_metric_requests m
    JOIN usage_request_ledger l ON l.request_id = m.request_id AND l.recorded_at = m.started_at
  `).all();
  const subtract = db.prepare(`
    UPDATE usage_daily SET requests = requests - 1, input_tokens = input_tokens - $input,
      output_tokens = output_tokens - $output, cache_read_tokens = cache_read_tokens - $read,
      cache_write_tokens = cache_write_tokens - $write, cost = MAX(0, cost - $cost)
    WHERE workspace = '' AND day = $day AND provider_id = $provider AND model_id = $model
      AND requests > 0 AND input_tokens >= $input AND output_tokens >= $output
      AND cache_read_tokens >= $read AND cache_write_tokens >= $write AND cost + 1e-12 >= $cost
      AND (requests > 1 OR (input_tokens = $input AND output_tokens = $output
        AND cache_read_tokens = $read AND cache_write_tokens = $write AND abs(cost - $cost) < 1e-12))
  `);
  const add = db.prepare(addDailyUsage);
  const workspaces = new Map();
  for (const row of verified) {
    if (!workspaces.has(row.conversation_id)) workspaces.set(row.conversation_id, usageWorkspace(db, row.conversation_id));
    const workspace = workspaces.get(row.conversation_id);
    if (!workspace) continue;
    const moved = subtract.run({ day: row.day, provider: row.provider_id, model: row.model_id,
      input: row.input_tokens, output: row.output_tokens, read: row.cache_read_tokens, write: row.cache_write_tokens, cost: row.cost });
    if (moved.changes) add.run(workspace, row.day, row.provider_id, row.model_id, row.input_tokens, row.output_tokens,
      row.cache_read_tokens, row.cache_write_tokens, row.cost, row.started_at);
  }
  db.exec("DELETE FROM usage_daily WHERE workspace = '' AND requests = 0");
}

module.exports = { activeProjectIds, addDailyUsage, listUsageProjects, migrateUsageProjects, usageWorkspace };
