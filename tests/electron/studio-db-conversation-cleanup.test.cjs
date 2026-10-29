const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createStudioDatabase } = require('../../electron/core/studio-db.cjs');

function createDurableSchema(database) {
  database.db.exec(`
    CREATE TABLE durable_conversations (
      id INTEGER PRIMARY KEY,
      owner_conversation_id INTEGER,
      owner_task_id INTEGER,
      record TEXT NOT NULL CHECK (json_valid(record))
    );
    CREATE TABLE durable_tasks (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      abort_requested INTEGER NOT NULL DEFAULT 0,
      background INTEGER NOT NULL DEFAULT 0,
      record TEXT NOT NULL CHECK (json_valid(record))
    );
    CREATE TABLE durable_entries (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      head INTEGER,
      commit_seq INTEGER NOT NULL,
      record TEXT NOT NULL CHECK (json_valid(record))
    );
    CREATE TABLE durable_submissions (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      request_id TEXT,
      status TEXT NOT NULL,
      record TEXT NOT NULL CHECK (json_valid(record))
    );
    CREATE TABLE durable_documents (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      family INTEGER NOT NULL,
      key_value TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      retired_at INTEGER,
      record TEXT NOT NULL CHECK (json_valid(record))
    );
    CREATE TABLE durable_document_revisions (
      document_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      record TEXT NOT NULL
    );
    CREATE TABLE durable_record_ids (
      id INTEGER PRIMARY KEY,
      record_type TEXT NOT NULL
    );
  `);
}

function insertDurableConversation(database, id, ownerConversationId = null, ownerTaskId = null) {
  database.db.prepare(`
    INSERT INTO durable_conversations(id, owner_conversation_id, owner_task_id, record)
    VALUES (?, ?, ?, ?)
  `).run(id, ownerConversationId, ownerTaskId, JSON.stringify({ id }));
  database.db.prepare('INSERT INTO durable_record_ids(id, record_type) VALUES (?, ?)')
    .run(id, 'conversation');
}

function insertDurableTask(database, id, conversationId, input = null) {
  database.db.prepare(`
    INSERT INTO durable_tasks(
      id, conversation_id, kind, status, abort_requested, background, record
    ) VALUES (?, ?, ?, 'terminal', 0, ?, ?)
  `).run(
    id,
    conversationId,
    input ? 'studio.subagent-reporter' : 'pi.generation',
    input ? 1 : 0,
    JSON.stringify({ id, conversationId, input }),
  );
  database.db.prepare('INSERT INTO durable_record_ids(id, record_type) VALUES (?, ?)')
    .run(id, 'task');
}

function insertDependentRecords(database, suffix, conversationId, taskId) {
  const submissionId = suffix + 10_000;
  const conversationDocumentId = suffix + 12_000;
  const taskDocumentId = suffix + 13_000;
  database.db.prepare(`
    INSERT INTO durable_entries(id, conversation_id, head, commit_seq, record)
    VALUES (?, ?, NULL, 1, ?)
  `).run(suffix, conversationId, JSON.stringify({ id: suffix }));
  database.db.prepare(`
    INSERT INTO durable_submissions(id, conversation_id, request_id, status, record)
    VALUES (?, ?, ?, 'done', ?)
  `).run(submissionId, conversationId, `request-${suffix}`, JSON.stringify({ id: submissionId }));
  for (const [id, ownerKind, ownerId] of [
    [conversationDocumentId, 'conversation', conversationId],
    [taskDocumentId, 'task', taskId],
  ]) {
    database.db.prepare(`
      INSERT INTO durable_documents(
        id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record
      ) VALUES (?, 'test.document', 0, '', ?, ?, 1, NULL, ?)
    `).run(id, ownerKind, ownerId, JSON.stringify({ id }));
    database.db.prepare(`
      INSERT INTO durable_document_revisions(document_id, revision, record)
      VALUES (?, 1, ?)
    `).run(id, JSON.stringify({ id, value: 'revision' }));
    database.db.prepare('INSERT INTO durable_record_ids(id, record_type) VALUES (?, ?)')
      .run(id, 'document');
  }
  database.db.prepare('INSERT INTO durable_record_ids(id, record_type) VALUES (?, ?)')
    .run(submissionId, 'submission');
  database.db.prepare('INSERT INTO durable_record_ids(id, record_type) VALUES (?, ?)')
    .run(suffix, 'entry');
  database.recordMetricRequest({
    requestId: `metric-request-${suffix}`,
    conversationId: String(conversationId),
    at: suffix,
    finishedAt: suffix + 10,
    providerId: 'test',
    modelId: 'test-model',
    durationMs: 10,
    input: 1,
    output: 1,
  });
}

function rowCount(database, table, where = '', values = []) {
  return Number(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get(...values).count);
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-cleanup-'));
  const database = createStudioDatabase(path.join(directory, 'studio.sqlite'));
  createDurableSchema(database);
  const parent = database.insertConversation({
    id: '10',
    publicId: 'parent-public',
    workspace: directory,
    kind: 'conversation',
    title: 'Parent',
  });
  const unrelated = database.insertConversation({
    id: '20',
    publicId: 'unrelated-public',
    workspace: directory,
    kind: 'conversation',
    title: 'Unrelated',
  });
  insertDurableConversation(database, 10);
  insertDurableConversation(database, 11, 10, 100);
  insertDurableConversation(database, 12, 11, 111);
  insertDurableConversation(database, 20);

  insertDurableTask(database, 90, 10);
  insertDurableTask(database, 100, 10);
  insertDurableTask(database, 101, 10, { conversationId: 11 });
  insertDurableTask(database, 110, 11);
  insertDurableTask(database, 111, 11);
  insertDurableTask(database, 112, 11, { conversationId: 12 });
  insertDurableTask(database, 120, 12);
  insertDurableTask(database, 200, 20);

  insertDependentRecords(database, 1000, 10, 90);
  insertDependentRecords(database, 1100, 11, 110);
  insertDependentRecords(database, 1200, 12, 120);
  insertDependentRecords(database, 5000, 20, 200);
  database.saveTurnDiff('parent-public', { at: 1, files: ['parent'] });
  database.saveTurnDiff('unrelated-public', { at: 2, files: ['unrelated'] });
  return { database, directory, parent, unrelated };
}

test('standalone child cleanup removes its tree and parent-owned anchor/reporter tasks', () => {
  const { database, directory } = fixture();
  try {
    const tree = database.durableConversationTree([11]);
    assert.deepEqual(tree.conversationIds, [11, 12]);
    assert.deepEqual(tree.taskIds, [100, 101, 110, 111, 112, 120]);

    const removed = database.deleteConversationTrees([11]);
    assert.deepEqual(removed.conversationIds, [11, 12]);
    assert.equal(rowCount(database, 'durable_conversations', 'WHERE id IN (11, 12)'), 0);
    assert.equal(rowCount(database, 'durable_tasks', 'WHERE id IN (100, 101, 110, 111, 112, 120)'), 0);
    assert.equal(rowCount(database, 'durable_tasks', 'WHERE id IN (90, 200)'), 2);
    assert.equal(rowCount(database, 'durable_documents', 'WHERE owner_id IN (100, 101, 110, 111, 112, 120)'), 0);
    assert.equal(rowCount(database, 'durable_document_revisions', 'WHERE document_id IN (13100, 13200, 14100, 14200)'), 0);
    assert.equal(rowCount(database, 'durable_record_ids', 'WHERE id IN (11, 12, 100, 101, 110, 111, 112, 120)'), 0);
    assert.equal(rowCount(database, 'conversation_metric_requests', 'WHERE conversation_id IN (11, 12)'), 0);
    assert.equal(rowCount(database, 'conversation_metric_requests', 'WHERE conversation_id IN (10, 20)'), 2);
    assert.equal(rowCount(database, 'turn_diffs', "WHERE conversation_id = 'unrelated-public'"), 1);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('parent cleanup removes every descendant while preserving unrelated conversations', () => {
  const { database, directory } = fixture();
  try {
    const removed = database.deleteConversationTrees([10]);
    assert.deepEqual(removed.conversationIds, [10, 11, 12]);
    assert.equal(rowCount(database, 'durable_conversations', 'WHERE id IN (10, 11, 12)'), 0);
    assert.equal(rowCount(database, 'durable_conversations', 'WHERE id = 20'), 1);
    assert.equal(rowCount(database, 'durable_tasks', 'WHERE conversation_id IN (10, 11, 12)'), 0);
    assert.equal(rowCount(database, 'durable_tasks', 'WHERE conversation_id = 20'), 1);
    assert.equal(rowCount(database, 'conversations', "WHERE id = '10'"), 0);
    assert.equal(rowCount(database, 'conversations', "WHERE id = '20'"), 1);
    assert.equal(rowCount(database, 'turn_diffs', "WHERE conversation_id = 'parent-public'"), 0);
    assert.equal(rowCount(database, 'turn_diffs', "WHERE conversation_id = 'unrelated-public'"), 1);
    assert.equal(rowCount(database, 'durable_record_ids', 'WHERE id IN (1000, 1100, 1200)'), 0);
    assert.equal(rowCount(database, 'durable_record_ids', 'WHERE id = 5000'), 1);
    assert.equal(rowCount(database, 'conversation_metric_requests', 'WHERE conversation_id IN (10, 11, 12)'), 0);
    assert.equal(rowCount(database, 'conversation_metric_requests', 'WHERE conversation_id = 20'), 1);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('workspace removal clears only project extensions bound to that workspace', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-workspace-cleanup-'));
  const database = createStudioDatabase(path.join(directory, 'studio.sqlite'));
  const workspace = path.join(directory, 'workspace-a');
  const otherWorkspace = path.join(directory, 'workspace-b');
  try {
    database.upsertWorkspace({ cwd: workspace, name: 'A' });
    database.upsertWorkspace({ cwd: otherWorkspace, name: 'B' });
    database.setProjectResourceTrust({
      workspace,
      kind: 'skill',
      resourcePath: path.join(workspace, '.pi-studio', 'skills', 'one'),
      contentHash: 'hash-a',
      trusted: true,
    });
    database.upsertExtension({
      id: 'project:same-id-a',
      name: 'A extension',
      version: '1.0.0',
      scope: 'project',
      source: path.join(workspace, '.pi-studio', 'extensions', 'same-id', 'pi-studio.extension.json'),
      manifest: { id: 'same-id-a' },
      trusted: true,
    });
    database.upsertExtension({
      id: 'project:same-id-b',
      name: 'B extension',
      version: '1.0.0',
      scope: 'project',
      source: path.join(otherWorkspace, '.pi-studio', 'extensions', 'same-id', 'pi-studio.extension.json'),
      manifest: { id: 'same-id-b' },
      trusted: true,
    });

    database.removeWorkspace(workspace);
    assert.equal(database.getWorkspace(workspace), undefined);
    assert.equal(database.getExtension('project:same-id-a'), undefined);
    assert.equal(database.getExtension('project:same-id-b').name, 'B extension');
    assert.equal(rowCount(database, 'project_resource_trust', 'WHERE workspace = ?', [workspace]), 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
