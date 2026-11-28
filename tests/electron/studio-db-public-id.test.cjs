const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  createStudioDatabase,
} = require('../../electron/main/core/studio-db.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-public-id-'));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test.after(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('conversation projections expose a stable UUID while Durable keeps its numeric ID', () => {
  const db = createStudioDatabase(path.join(temporary, 'current.sqlite'));
  try {
    const inserted = db.insertConversation({
      id: '44',
      workspace: temporary,
      kind: 'durable',
      title: 'UUID projection',
    });
    assert.equal(inserted.id, '44');
    assert.match(inserted.publicId, uuidPattern);
    assert.equal(db.getConversation(inserted.publicId).id, '44');
    assert.equal(db.getConversation('44').publicId, inserted.publicId);

    const updated = db.updateConversation(inserted.publicId, {
      title: 'Updated through public ID',
      lastDurationMs: 12_345,
    });
    assert.equal(updated.id, '44');
    assert.equal(updated.publicId, inserted.publicId);
    assert.equal(updated.title, 'Updated through public ID');
    assert.equal(updated.lastDurationMs, 12_345);
  } finally {
    db.close();
  }
});

test('the v10 migration backfills UUIDs and moves legacy session keys', () => {
  const filename = path.join(temporary, 'legacy.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      kind TEXT NOT NULL,
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
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE turn_diffs (
      conversation_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (conversation_id, at)
    );
    CREATE TABLE conversation_metric_requests (
      request_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      tps REAL NOT NULL,
      ttft_ms REAL,
      duration_ms REAL NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      cost REAL NOT NULL
    );
    INSERT INTO conversations(
      id, workspace, kind, title, created_at, updated_at
    ) VALUES ('44', '${temporary.replaceAll("'", "''")}', 'durable', 'Legacy', 1, 1);
    INSERT INTO turn_diffs(conversation_id, at, payload)
      VALUES ('44', 1, '{"at":1,"files":[]}');
    INSERT INTO settings(key, value, updated_at)
      VALUES (
        'studio.permissions.policy',
        '{"version":1,"sessions":{"44":{"preset":"full"}}}',
        1
      );
    INSERT INTO conversation_metric_requests(
      request_id, conversation_id, started_at, finished_at, status,
      provider_id, model_id, tps, ttft_ms, duration_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost
    ) VALUES (
      'request-1', '44', 1, 6000, 'done',
      'test', 'model', 10, 500, 5900,
      1, 1, 0, 0, 0
    );
    PRAGMA user_version = 9;
  `);
  legacy.close();

  const db = createStudioDatabase(filename);
  try {
    const row = db.getConversation('44');
    assert.match(row.publicId, uuidPattern);
    assert.equal(db.getConversation(row.publicId).id, '44');
    assert.equal(db.getConversation(row.publicId).lastDurationMs, 5_900);
    assert.equal(db.readTurnDiffs(row.publicId).length, 1);
    assert.equal(db.readTurnDiffs('44').length, 0);
    assert.equal(
      db.getSetting('studio.permissions.policy').sessions[row.publicId].preset,
      'full',
    );
    assert.equal(db.getSetting('studio.permissions.policy').sessions['44'], undefined);
  } finally {
    db.close();
  }
});

test('session layouts survive restart and cannot be recreated by late writes after deletion', () => {
  const filename = path.join(temporary, 'layouts.sqlite');
  let db = createStudioDatabase(filename);
  try {
    const session = db.insertConversation({id:'88', workspace:temporary, kind:'durable', title:'Layout'});
    const owner = 'conversation:' + session.publicId;
    db.createTemporaryChat({id:'quick',durableId:'90',title:'Quick',modelRef:'demo',thinkingLevel:'default',hasImages:false});
    db.upsertWorkspace({cwd:temporary});
    const tree = 'worktree:' + JSON.stringify([temporary, 'directory', '']);
    db.setSessionLayout(tree,'center',{active:'file-a'});
    db.setSessionLayout('draft:' + temporary,'tools',{active:'browser'});
    db.adoptDraftTools(temporary,session.publicId);
    assert.equal(db.getSessionLayout('draft:' + temporary,'center'),null);
    assert.equal(db.getSessionLayout('draft:' + temporary,'tools'),null);
    db.setSessionLayout('temporary:quick','center',{active:'chat'});
    db.setSessionLayout('studio','navigation',{sessionId:session.publicId});
    db.close();
    db = createStudioDatabase(filename);
    assert.deepEqual(db.getSessionLayout(tree,'center'),{active:'file-a'});
    assert.deepEqual(db.getSessionLayout(owner,'tools'),{active:'browser'});
    assert.deepEqual(db.getSessionLayout('studio','navigation'),{sessionId:session.publicId});
    assert.deepEqual(db.getSessionLayout('temporary:quick','center'),{active:'chat'});
    db.deleteConversation(session.publicId);
    db.removeTemporaryChatIndex('quick','90');
    for (const key of [owner,'temporary:quick']) {
      db.setSessionLayout(key,'center',{active:'stale'});
      assert.equal(db.getSessionLayout(key,'center'),null);
      assert.equal(db.getSessionLayout(key,'tools'),null);
    }
  } finally {
    db.close();
  }
});

test('v32 merges saved documents by checkout and keeps the selected file and each conversation reading position', () => {
  const filename = path.join(temporary, 'v31-layouts.sqlite');
  let db = createStudioDatabase(filename);
  try {
    const a = db.insertConversation({id:'11', workspace:temporary, kind:'durable', title:'A'});
    const b = db.insertConversation({id:'12', workspace:temporary, kind:'durable', title:'B'});
    db.setWorkspaceTreeRecord(temporary, {branch:'main', main:true, projectRoot:temporary, detached:false});
    const file = {id:'readme', kind:'file', path:'README.md', cwd:temporary, source:'workspace', title:'README.md'};
    db.setSessionLayout('conversation:' + a.publicId, 'center', {tabs:[{...file, scroll:360}], active:'readme', reading:{entry:4, offset:6}});
    db.setSessionLayout('conversation:' + b.publicId, 'center', {tabs:[{...file, scroll:20}], active:'chat', reading:{entry:8, offset:2}});
    db.setSessionLayout('studio', 'navigation', {sessionId:a.publicId, cwd:temporary});
    db.db.exec('PRAGMA user_version = 31');
    db.close();
    db = createStudioDatabase(filename);
    const key = 'worktree:' + JSON.stringify([temporary,'branch','main']);
    const layout = db.getSessionLayout(key, 'center');
    assert.equal(layout.active, 'readme');
    assert.equal(layout.tabs.length, 3);
    assert.equal(layout.tabs.find(t => t.id === 'readme').scroll, 360);
    assert.equal(layout.tabs.find(t => t.sessionId === b.publicId).reading.entry, 8);
    assert.equal(db.getSessionLayout('conversation:' + a.publicId, 'center'), null);
    db.deleteConversation(a.publicId);
    const remaining = db.getSessionLayout(key, 'center');
    assert.equal(remaining.lastConversationId, b.publicId);
    assert.equal(remaining.tabs.length, 2);
    db.deleteConversation(b.publicId);
    db.removeWorkspace(temporary);
    assert.equal(db.getSessionLayout(key, 'center'), null);
    db.setSessionLayout(key, 'center', layout);
    assert.equal(db.getSessionLayout(key, 'center'), null);
  } finally { db.close(); }
});

test('the inspector follows its saved conversation across migration and deletion', () => {
  const filename = path.join(temporary, 'v33-inspector.sqlite');
  let db = createStudioDatabase(filename);
  try {
    const a = db.insertConversation({id:'61', workspace:temporary, kind:'durable', title:'A'});
    const b = db.insertConversation({id:'62', workspace:temporary, kind:'durable', title:'B'});
    const tree = 'worktree:' + JSON.stringify([temporary, 'directory', '']);
    db.upsertWorkspace({cwd:temporary});
    const center = { active:'chat', lastConversationId:a.publicId, side:'git', tabs:[] };
    db.setSessionLayout(tree, 'center', { ...center, inspector:'progress', progressPage:'tasks' });
    db.db.exec('PRAGMA user_version = 33');
    db.close();
    db = createStudioDatabase(filename);
    const owner = 'conversation:' + a.publicId;
    const other = 'conversation:' + b.publicId;
    assert.deepEqual(db.getSessionLayout(tree, 'center'), center);
    assert.equal(db.getSessionLayout(owner, 'inspector').progressPage, 'tasks');
    assert.equal(db.getSessionLayout(owner, 'inspector').mode, 'expanded');
    assert.equal(db.getSessionLayout(other, 'inspector'), null);
    assert.throws(() => db.setSessionLayout(tree, 'inspector', {}));
    const view = { mode:'compact', seenTurn:'240', position:{top:10, right:20} };
    db.setSessionLayout(other, 'inspector', view);
    db.deleteConversation(a.publicId);
    db.setSessionLayout(owner, 'inspector', view);
    assert.equal(db.getSessionLayout(owner, 'inspector'), null);
    assert.deepEqual(db.getSessionLayout(other, 'inspector'), view);
  } finally { db.close(); }
});
