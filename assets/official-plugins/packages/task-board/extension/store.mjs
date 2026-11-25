import { lstatSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATABASE_VERSION = 1;
const DATE_COLUMNS = new Map([
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at'],
  ['plannedStartAt', 'planned_start_at'],
  ['plannedEndAt', 'planned_end_at'],
  ['actualStartAt', 'actual_start_at'],
  ['actualEndAt', 'actual_end_at'],
]);
const TASK_COLUMNS = `
  id, title, details, status, priority, revision,
  created_at AS createdAt, updated_at AS updatedAt,
  planned_start_at AS plannedStartAt, planned_end_at AS plannedEndAt,
  actual_start_at AS actualStartAt, actual_end_at AS actualEndAt
`;

function localDay(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, '0')).join('-');
}

function dateBoundary(day, today, next = false) {
  const midnight = new Date((day === 'today' ? today : day) + 'T00:00:00');
  if (next) midnight.setDate(midnight.getDate() + 1);
  const iso = midnight.toISOString();
  // A boundary beyond the supported four-digit UTC years sorts after all tasks.
  return iso.startsWith('+') ? '~' : iso;
}

function scheduleValues({ plannedStartAt, plannedEndAt, actualStartAt, actualEndAt }) {
  if (plannedStartAt && plannedEndAt && plannedEndAt < plannedStartAt) {
    throw new Error('计划结束时间需晚于或等于计划开始时间');
  }
  if (actualStartAt && actualEndAt && actualEndAt < actualStartAt) {
    throw new Error('实际结束时间需晚于或等于实际开始时间');
  }
  return [plannedStartAt, plannedEndAt, actualStartAt, actualEndAt];
}

export function openTaskStore(directory, now = () => new Date()) {
  const filename = path.join(directory, 'tasks.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const stat = lstatSync(filename + suffix, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error('任务数据库位置需要是普通文件');
  }
  const db = new DatabaseSync(filename, { timeout: 2_500 });
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > DATABASE_VERSION) throw new Error('任务数据由更新版本的插件创建');
    db.exec('PRAGMA journal_mode = WAL');
    if (version === 0) db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        details TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'blocked', 'done')),
        priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        planned_start_at TEXT,
        planned_end_at TEXT,
        actual_start_at TEXT,
        actual_end_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at DESC, id);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, created_at DESC, id);
      PRAGMA user_version = ${DATABASE_VERSION};
      COMMIT;
    `);
  } catch (error) {
    db.close();
    throw error;
  }

  const find = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`);
  const insert = db.prepare(`
    INSERT INTO tasks (id, title, details, status, priority, planned_start_at, planned_end_at,
      actual_start_at, actual_end_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING RETURNING ${TASK_COLUMNS}
  `);
  const update = db.prepare(`
    UPDATE tasks SET title = ?, details = ?, status = ?, priority = ?, planned_start_at = ?, planned_end_at = ?,
      actual_start_at = ?, actual_end_at = ?, updated_at = ?, revision = revision + 1
    WHERE id = ? AND revision = ?
    RETURNING ${TASK_COLUMNS}
  `);

  function query({ status, dateField, from, to, limit, offset }) {
    const conditions = [];
    const values = [];
    if (status) {
      conditions.push('status = ?');
      values.push(status);
    }
    if (from || to) {
      const column = DATE_COLUMNS.get(dateField);
      if (!column) throw new Error('日期字段无效');
      const today = localDay(now());
      if (from && to && (from === 'today' ? today : from) > (to === 'today' ? today : to)) {
        throw new Error('查询结束日期需晚于或等于开始日期');
      }
      if (from) {
        conditions.push(column + ' >= ?');
        values.push(dateBoundary(from, today));
      }
      if (to) {
        conditions.push(column + ' < ?');
        values.push(dateBoundary(to, today, true));
      }
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const { total } = db.prepare('SELECT COUNT(*) AS total FROM tasks' + where).get(...values);
    const tasks = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
      .all(...values, limit, offset);
    const end = offset + tasks.length;
    return { tasks, total, nextOffset: end < total ? end : null };
  }

  function write({ action, id, fields, revision }) {
    const time = now().toISOString();
    if (action === 'create') {
      const { title, details, status, priority } = fields;
      return insert.get(id, title, details, status, priority, ...scheduleValues(fields), time, time) ?? find.get(id);
    }
    const current = find.get(id);
    if (!current) throw new Error('任务不存在');
    if (current.revision !== revision) throw new Error('任务已被更新，请重新打开任务后再保存');
    const task = { ...current, ...fields };
    const saved = update.get(task.title, task.details, task.status, task.priority,
      ...scheduleValues(task), time, id, revision);
    if (!saved) throw new Error('任务已被更新，请重新打开任务后再保存');
    return saved;
  }

  return { query, write, get: id => find.get(id), close: () => db.close() };
}
