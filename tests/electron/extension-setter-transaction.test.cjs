const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');
installElectronSafeStorage({ after });
const { createStudioDatabase } = require('../../electron/core/studio-db.cjs');

for (const method of ['setExtensionEnabled', 'setExtensionTrusted']) {
  test(`${method} rolls back UPDATE if the result read fails, then permits a deliberate retry`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-extension-setter-'));
    const filename = path.join(root, 'studio.sqlite');
    const db = createStudioDatabase(filename);
    t.after(() => { db.close(); fs.rmSync(root, {recursive:true,force:true}); });
    db.upsertExtension({id:'project:fixture',scope:'project',source:'/synthetic/extension.json',name:'Fixture',version:'1',enabled:true,trusted:true,contentHash:'reviewed-hash',manifest:{id:'fixture'}});
    const before = db.getExtension('project:fixture');
    const read = db.getExtension.bind(db);
    db.getExtension = () => { throw new Error('injected post-update read failure'); };
    assert.throws(() => db[method]('project:fixture', false, ''), /post-update read failure/);
    db.getExtension = read;
    const afterFailure = db.getExtension('project:fixture');
    assert.equal(afterFailure.enabled, before.enabled);
    assert.equal(afterFailure.trusted, before.trusted);
    assert.equal(afterFailure.contentHash, before.contentHash);
    assert.equal(afterFailure.updatedAt, before.updatedAt);
    const result = db[method]('project:fixture', false, '');
    assert.equal(result[method === 'setExtensionEnabled' ? 'enabled' : 'trusted'], false);
    if (method === 'setExtensionTrusted') assert.equal(result.contentHash, '');
    // A new connection proves committed persistence, not just an in-memory row.
    const second = createStudioDatabase(filename);
    try { assert.equal(second.getExtension('project:fixture')[method === 'setExtensionEnabled' ? 'enabled' : 'trusted'], false); }
    finally { second.close(); }
  });
}
