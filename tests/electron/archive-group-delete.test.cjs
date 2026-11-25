const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pluginDataDirectory } = require('../../electron/main/core/studio-paths.cjs');
const { uploadDirectory } = require('../../electron/main/services/conversation-assets.cjs');
const { flushConversationFileCleanup } = require('../../electron/main/services/conversation-file-cleanup.cjs');

test('group deletion validates the confirmed archived IDs and preserves the project and all other sessions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-archive-'));
  process.env.PI_STUDIO_USER_DATA = directory;
  process.env.PI_STUDIO_DB = path.join(directory, 'studio.sqlite');
  const { getStudioDatabase, closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
  t.after(() => {
    closeStudioDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { conversationAction } = require('../../electron/main/runtime/conversations.cjs');
  const db = getStudioDatabase();
  for (const [id, publicId, workspace, archived] of [
    [1, 'selected', '/A', true], [2, 'restored', '/A', false],
    [3, 'hidden-by-filter', '/A', true], [4, 'other-project', '/B', true],
  ]) {
    db.insertConversation({ id: String(id), publicId, workspace, archived, kind: 'conversation' });
  }
  const boards = pluginDataDirectory('studio.excalidraw', 'studio.excalidraw', { create: true });
  const board = path.join(boards, '1.excalidraw.json');
  const staging = board + '.40b37da7-22d1-4677-9cf3-ec007c061608.tmp';
  const otherBoard = path.join(boards, '3.excalidraw.json');
  for (const file of [board, staging, otherBoard]) fs.writeFileSync(file, '{}');
  const assets = uploadDirectory(db.getConversation('selected'));
  fs.writeFileSync(path.join(assets, 'input.txt'), 'session file');
  db.setSetting('studio.permissions.policy', { sessions: { selected: {}, 1: {}, restored: {} } });
  db.setSetting('studio.sensitive-input-exemptions', { selected: ['old'], restored: ['keep'] });
  const remove = sessionIds => conversationAction({ kind: 'workspace', id: '/A', action: 'remove-archived', sessionIds });
  await assert.rejects(remove([]));
  await assert.rejects(remove(['selected', 'restored']));
  await assert.rejects(remove(['selected', 'other-project']));
  assert.equal(db.listConversations().length, 4);
  assert.ok(fs.existsSync(board));
  const removed = await remove(['selected']);
  assert.equal(removed.pendingFileCleanups, 0);
  assert.deepEqual(db.listConversations().map(item => item.publicId).sort(), ['hidden-by-filter', 'other-project', 'restored']);
  assert.ok(db.listWorkspaces().some(item => item.cwd === '/A'));
  assert.equal(fs.existsSync(board), false);
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.existsSync(assets), false);
  assert.ok(fs.existsSync(otherBoard));
  assert.deepEqual(db.getSetting('studio.permissions.policy').sessions, { restored: {} });
  assert.deepEqual(db.getSetting('studio.sensitive-input-exemptions'), { restored: ['keep'] });
});

test('filesystem cleanup survives restart and never follows a replaced plugin data directory', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-delete-retry-'));
  process.env.PI_STUDIO_USER_DATA = directory;
  process.env.PI_STUDIO_DB = path.join(directory, 'studio.sqlite');
  const { getStudioDatabase, closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
  t.after(() => {
    closeStudioDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { conversationAction } = require('../../electron/main/runtime/conversations.cjs');
  const db = getStudioDatabase();
  const row = db.insertConversation({ id: '16', workspace: directory, kind: 'conversation' });
  const boards = pluginDataDirectory('studio.excalidraw', 'studio.excalidraw', { create: true });
  const relocated = path.join(directory, 'relocated');
  fs.renameSync(boards, relocated);
  const file = '16.excalidraw.json';
  fs.writeFileSync(path.join(relocated, file), '{}');
  fs.symlinkSync(relocated, boards, 'junction');

  const removed = await conversationAction({ kind: 'session', id: row.publicId, action: 'remove' });
  assert.equal(removed.pendingFileCleanups, 1);
  assert.equal(db.getConversation(row.publicId), undefined);
  assert.ok(fs.existsSync(path.join(relocated, file)));
  closeStudioDatabase();

  fs.unlinkSync(boards);
  fs.mkdirSync(boards);
  fs.copyFileSync(path.join(relocated, file), path.join(boards, file));
  const reopened = getStudioDatabase();
  assert.equal(flushConversationFileCleanup(reopened).pendingFileCleanups, 0);
  assert.equal(flushConversationFileCleanup(reopened).pendingFileCleanups, 0);
  assert.equal(fs.existsSync(path.join(boards, file)), false);
  assert.ok(fs.existsSync(path.join(relocated, file)));
  assert.equal(reopened.db.prepare('SELECT count(*) AS count FROM studio_conversation_file_cleanup').get().count, 0);
});
