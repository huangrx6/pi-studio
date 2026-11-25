const fs = require('node:fs');
const path = require('node:path');
const { managedDataSubdirectory, pluginDataDirectory, studioDataDirectory } = require('../core/studio-paths.cjs');
const { assetOwner, removeConversationAssets } = require('./conversation-assets.cjs');
const { removeAttachmentDirectory } = require('./attachments.cjs');

const EXCALIDRAW_ID = 'studio.excalidraw';
const CANVAS_FILE = /^([1-9]\d*)\.excalidraw\.json(?:\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp)?$/;

function findExcalidrawFiles(records, root) {
  // The package can keep its data when disabled or uninstalled. Cleanup uses
  // the storage contract directly and never loads extension code.
  const directories = [
    pluginDataDirectory(EXCALIDRAW_ID, EXCALIDRAW_ID, { root }),
    managedDataSubdirectory(root, ['extensions', EXCALIDRAW_ID, '.data']),
  ];
  const extensionData = managedDataSubdirectory(root, ['extension-data']);
  if (extensionData) {
    for (const scope of fs.readdirSync(extensionData, { withFileTypes: true })) {
      if (!scope.isDirectory() || !/^(?:user|project-[0-9a-f]{24})$/.test(scope.name)) continue;
      directories.push(managedDataSubdirectory(extensionData, [scope.name, EXCALIDRAW_ID]));
    }
  }
  const files = new Map(records.map(record => [String(record.conversation_id), []]));
  for (const directory of directories.filter(Boolean)) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const id = CANVAS_FILE.exec(entry.name)?.[1];
      files.get(id)?.push(path.join(directory, entry.name));
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
  let canvasFiles;
  let canvasError;
  try { canvasFiles = findExcalidrawFiles(records, root); }
  catch (error) { canvasError = error; }
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
        if (canvasError) throw canvasError;
        for (const file of canvasFiles.get(String(id))) fs.rmSync(file, { force: true });
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
