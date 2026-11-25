const fs = require('node:fs');
const path = require('node:path');
const {
  STUDIO_MANAGED_DATA_DIR,
  managedDataSubdirectory,
  studioDataDirectory,
} = require('../core/studio-paths.cjs');
const { assetOwner, removeConversationAssets } = require('./conversation-assets.cjs');
const { removeAttachmentDirectory } = require('./attachments.cjs');

const SESSION_ARTIFACT = /^([1-9]\d*)(?:\..+)?$/;

function findPluginSessionFiles(records, root) {
  // Plugins that store per-conversation files place them under `<dataDir>/sessions/<conversationId>.*`.
  // Cleanup uses this generic storage convention without referencing any specific plugin ID
  // and validates every segment through `managedDataSubdirectory` so symlinks are never followed.
  const targetIds = new Set(records.map((record) => String(record.conversation_id)));
  const files = new Map(records.map((record) => [String(record.conversation_id), []]));
  const sessionDirs = [];

  for (const baseParts of [[STUDIO_MANAGED_DATA_DIR, 'plugin-data'], ['plugin-data']]) {
    const pluginDataRoot = managedDataSubdirectory(root, baseParts);
    if (!pluginDataRoot) continue;
    for (const pluginEntry of fs.readdirSync(pluginDataRoot, { withFileTypes: true })) {
      if (pluginEntry.name.startsWith('.')) continue;
      const pluginDir = managedDataSubdirectory(pluginDataRoot, [pluginEntry.name]);
      if (!pluginDir) continue;
      for (const extEntry of fs.readdirSync(pluginDir, { withFileTypes: true })) {
        if (extEntry.name.startsWith('.')) continue;
        const extDir = managedDataSubdirectory(pluginDir, [extEntry.name]);
        if (!extDir) continue;
        const sessions = managedDataSubdirectory(extDir, ['sessions']);
        if (sessions) sessionDirs.push(sessions);
      }
    }
  }

  for (const baseParts of [[STUDIO_MANAGED_DATA_DIR, 'extension-data'], ['extension-data']]) {
    const extensionData = managedDataSubdirectory(root, baseParts);
    if (!extensionData) continue;
    for (const scope of fs.readdirSync(extensionData, { withFileTypes: true })) {
      if (!/^(?:user|project-[0-9a-f]{24})$/.test(scope.name)) continue;
      const scopeDir = managedDataSubdirectory(extensionData, [scope.name]);
      if (!scopeDir) continue;
      for (const extEntry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (extEntry.name.startsWith('.')) continue;
        const extDir = managedDataSubdirectory(scopeDir, [extEntry.name]);
        if (!extDir) continue;
        const sessions = managedDataSubdirectory(extDir, ['sessions']);
        if (sessions) sessionDirs.push(sessions);
      }
    }
  }

  for (const directory of sessionDirs) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isFile() && !entry.isDirectory()) continue;
      const id = SESSION_ARTIFACT.exec(entry.name)?.[1];
      if (id && targetIds.has(id)) {
        files.get(id)?.push(path.join(directory, entry.name));
      }
    }
  }
  return files;
}

function queueConversationFileCleanup(studio, ids, rows, tree) {
  const insert = studio.db.prepare(`
    INSERT OR IGNORE INTO studio_conversation_file_cleanup(conversation_id, public_id, attachment_owner)
    VALUES (?, ?, ?)
  `);
  const byId = new Map(rows.map(row => [String(row.id), row]));
  const durableIds = new Set(tree.conversationIds);
  for (const id of ids) {
    const row = byId.get(String(id));
    const owner = durableIds.has(id) ? assetOwner(studio.db, id) : row;
    const attachmentOwner = owner
      ? JSON.stringify({ workspace: owner.workspace, publicId: owner.publicId, childId: owner.childId })
      : null;
    insert.run(id, row?.publicId || '', attachmentOwner);
  }
}

function flushConversationFileCleanup(studio, ids = null, root = studioDataDirectory()) {
  const records = studio.db.prepare(`
    SELECT * FROM studio_conversation_file_cleanup
    WHERE ? IS NULL OR conversation_id IN (SELECT value FROM json_each(?))
    ORDER BY conversation_id
  `).all(ids === null ? null : 1, JSON.stringify(ids));
  if (!records.length) return { attachmentsRemoved: 0, pendingFileCleanups: 0 };
  const done = studio.db.prepare('DELETE FROM studio_conversation_file_cleanup WHERE conversation_id = ?');
  let pluginSessionFiles;
  let pluginSessionError;
  try { pluginSessionFiles = findPluginSessionFiles(records, root); }
  catch (error) { pluginSessionError = error; }
  let attachmentsRemoved = 0;
  let pendingFileCleanups = 0;
  for (const record of records) {
    try {
      const { conversation_id: id, public_id: publicId, attachment_owner: owner } = record;
      // A restored conversation can make a previously queued removal stale.
      if (!studio.getConversation(String(id)) && !studio.hasDurableConversation(id)) {
        if (owner && removeConversationAssets(JSON.parse(owner), root, { strict: true })) attachmentsRemoved += 1;
        for (const key of new Set([String(id), publicId].filter(Boolean))) {
          if (removeAttachmentDirectory(key, { root, strict: true })) attachmentsRemoved += 1;
        }
        if (pluginSessionError) throw pluginSessionError;
        for (const file of pluginSessionFiles.get(String(id))) fs.rmSync(file, { recursive: true, force: true });
      }
      done.run(id);
    } catch (error) {
      pendingFileCleanups += 1;
      console.warn('[pi-studio] 会话文件将在下次启动时重试清理', error.code || error.name);
    }
  }
  return { attachmentsRemoved, pendingFileCleanups };
}

module.exports = { flushConversationFileCleanup, queueConversationFileCleanup };
