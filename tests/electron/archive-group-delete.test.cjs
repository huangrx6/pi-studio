const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('group deletion validates the confirmed archived IDs and preserves the project and all other sessions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-archive-'));
  process.env.PI_STUDIO_USER_DATA = directory;
  process.env.PI_STUDIO_DB = path.join(directory, 'studio.sqlite');
  const { getStudioDatabase, closeStudioDatabase } = require('../../electron/core/studio-db.cjs');
  t.after(() => {
    closeStudioDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { conversationAction } = require('../../electron/runtime/conversations.cjs');
  const db = getStudioDatabase();
  for (const [id, publicId, workspace, archived] of [
    [1, 'selected', '/A', true], [2, 'restored', '/A', false],
    [3, 'hidden-by-filter', '/A', true], [4, 'other-project', '/B', true],
  ]) {
    db.insertConversation({ id: String(id), publicId, workspace, archived, kind: 'conversation' });
  }
  const remove = sessionIds => conversationAction({ kind: 'workspace', id: '/A', action: 'remove-archived', sessionIds });
  await assert.rejects(remove([]));
  await assert.rejects(remove(['selected', 'restored']));
  await assert.rejects(remove(['selected', 'other-project']));
  assert.equal(db.listConversations().length, 4);
  await remove(['selected']);
  assert.deepEqual(db.listConversations().map(item => item.publicId).sort(), ['hidden-by-filter', 'other-project', 'restored']);
  assert.ok(db.listWorkspaces().some(item => item.cwd === '/A'));
});
