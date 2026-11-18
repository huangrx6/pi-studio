// The outbox is in the same transaction as each Durable entry, including child-agent entries.
// The filesystem projection can be interrupted and replayed without changing a conversation.
const { studioDataDirectory } = require('../core/studio-paths.cjs');
const { assetOwner, materializeEntry, removeConversationAssets } = require('./conversation-assets.cjs');

function prepareAssetArchive(studio) {
  studio.transaction(() => {
    // Durable initializes its own schema when the harness opens.
    const installed = studio.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='studio_enqueue_asset_entry_v1'").get();
    if (installed) return;
    studio.db.exec(`
      CREATE TRIGGER studio_enqueue_asset_entry_v1 AFTER INSERT ON durable_entries BEGIN
        INSERT OR IGNORE INTO studio_asset_pending(entry_id, historical) VALUES (NEW.id, 0);
      END;
      INSERT OR IGNORE INTO studio_asset_pending(entry_id, historical) SELECT id, 1 FROM durable_entries;
    `);
  });
}

async function archiveNextEntry(studio, root = studioDataDirectory()) {
  const { db } = studio;
  const next = db.prepare(`SELECT entry_id, historical, retry_after FROM studio_asset_pending WHERE retry_after <= ?
    ORDER BY historical, entry_id LIMIT 1`).get(Date.now());
  if (!next) return false;
  const row = db.prepare('SELECT id, conversation_id, record FROM durable_entries WHERE id = ?').get(next.entry_id);
  try {
    if (row) {
      const owner = assetOwner(db, row.conversation_id);
      // The Studio row is inserted just after Durable creates the conversation.
      if (!owner && !next.historical && !next.retry_after) {
        db.prepare('UPDATE studio_asset_pending SET retry_after = ? WHERE entry_id = ?').run(Date.now() + 300_000, next.entry_id);
        return true;
      }
      if (owner) {
        await materializeEntry(db, { ...row, historical: next.historical }, owner, root);
        if (!db.prepare('SELECT 1 FROM durable_conversations WHERE id = ?').get(row.conversation_id)) removeConversationAssets(owner, root);
      }
    }
    db.prepare('DELETE FROM studio_asset_pending WHERE entry_id = ?').run(next.entry_id);
  } catch (error) {
    db.prepare('UPDATE studio_asset_pending SET retry_after = ? WHERE entry_id = ?').run(Date.now() + 60_000, next.entry_id);
    throw error;
  }
  return true;
}

function startAssetArchive(studio) {
  let prepared = false;
  try { prepareAssetArchive(studio); prepared = true; }
  catch (error) { console.warn('[pi-studio] 附件归档初始化将重试', error.code || error.name); }
  let timer;
  let running;
  let stopped = false;
  let lastWarning = 0;
  function schedule(delay) {
    if (!stopped) timer = setTimeout(() => { running = drain(); }, delay).unref();
  }
  async function drain() {
    try {
      if (!prepared) { prepareAssetArchive(studio); prepared = true; }
      // Keep long histories off the startup path and yield between small batches.
      const until = performance.now() + 8;
      do {
        if (stopped) return;
        if (!await archiveNextEntry(studio)) { schedule(1200); return; }
      } while (performance.now() < until);
      schedule(16);
    } catch (error) {
      if (Date.now() - lastWarning > 60_000) {
        console.warn('[pi-studio] 会话附件归档将重试', error.code || error.name);
        lastWarning = Date.now();
      }
      schedule(1200);
    }
  }
  schedule(0);
  return async function stop() { stopped = true; clearTimeout(timer); await running; };
}

module.exports = { startAssetArchive, prepareAssetArchive, archiveNextEntry };
