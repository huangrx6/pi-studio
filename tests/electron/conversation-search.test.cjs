const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStudioDatabase } = require('../../electron/core/studio-db.cjs');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-search-'));
  const db = createStudioDatabase(path.join(dir, 'studio.sqlite'));
  // durable_entries 由 Durable runtime 建表，这里补一份最小结构。
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS durable_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      head INTEGER,
      commit_seq INTEGER NOT NULL,
      record TEXT NOT NULL
    )
  `);
  const insert = db.db.prepare(`
    INSERT INTO durable_entries (conversation_id, head, commit_seq, record)
    VALUES (?, ?, ?, ?)
  `);
  return { dir, db, insert };
}

test('搜索按条目倒序返回，命中的通配符按字面匹配', () => {
  const { dir, db, insert } = sandbox();
  try {
    insert.run(7, 1, 1, JSON.stringify({ data: { displayText: 'plain text' } }));
    insert.run(7, 2, 2, JSON.stringify({ data: { displayText: 'a 100% match' } }));
    insert.run(7, 3, 3, JSON.stringify({ data: { displayText: 'under_score' } }));
    insert.run(8, 4, 4, JSON.stringify({ data: { displayText: 'a 100% match' } }));

    const percent = db.searchDurableEntries(7, '100%');
    assert.equal(percent.length, 1, '% 不能被当成通配符');
    assert.match(percent[0].record, /100% match/);

    const underscore = db.searchDurableEntries(7, 'under_score');
    assert.equal(underscore.length, 1, '_ 也要按字面匹配');

    const all = db.searchDurableEntries(7, '100% match');
    assert.equal(all.length, 1);
    // 会话隔离：另一个会话的同名内容不出现
    assert.equal(db.searchDurableEntries(8, 'plain').length, 0);
    assert.equal(db.searchDurableEntries(8, '100% match').length, 1);
    // 粗筛在 JSON 上做，字段名也会命中（例如 displayText），由调用方再过滤
    assert.equal(db.searchDurableEntries(7, 'plain').length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('空查询与超长 limit 都有确定行为', () => {
  const { dir, db, insert } = sandbox();
  try {
    for (let index = 0; index < 5; index += 1) {
      insert.run(9, index, index, JSON.stringify({ data: { displayText: `hit ${index}` } }));
    }
    assert.deepEqual(db.searchDurableEntries(9, ''), []);
    assert.deepEqual(db.searchDurableEntries(9, '   '), []);
    assert.equal(db.searchDurableEntries(9, 'hit').length, 5);
    assert.equal(db.searchDurableEntries(9, 'hit', { limit: 2 }).length, 2);
    assert.equal(db.searchDurableEntries(9, 'hit', { limit: 9999 }).length, 5, 'limit 被夹到上限');
    assert.equal(db.searchDurableEntries(404, 'hit').length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
