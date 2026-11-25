import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATABASE_VERSION = 2;
export const TASK_STATUSES = Object.freeze(['todo', 'in_progress', 'blocked', 'done']);
export const TASK_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);
export const TASK_TYPES = Object.freeze(['feature', 'bug', 'improvement', 'chore']);
export const ARCHIVE_MODES = Object.freeze(['active', 'archived', 'all']);
export const SCHEDULE_FIELDS = Object.freeze(['plannedStartAt', 'plannedEndAt', 'actualStartAt', 'actualEndAt']);
export const TASK_DATE_FIELDS = Object.freeze(['createdAt', 'updatedAt', 'archivedAt', ...SCHEDULE_FIELDS]);
export const MAX_PAGE_SIZE = 100;

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DAY = /^(?!0000)\d{4}-\d{2}-\d{2}$/;
const PRIORITY_RANK = Object.freeze({ urgent: 0, high: 1, normal: 2, low: 3 });
const TYPE_ORDER = ['feature', 'bug', 'improvement', 'chore'];

const DATE_COLUMNS = new Map([
  ['createdAt', 't.created_at'],
  ['updatedAt', 't.updated_at'],
  ['archivedAt', 't.archived_at'],
  ['plannedStartAt', 't.planned_start_at'],
  ['plannedEndAt', 't.planned_end_at'],
  ['actualStartAt', 't.actual_start_at'],
  ['actualEndAt', 't.actual_end_at'],
]);

const TASK_SELECT = `
  t.id, t.title, t.details, t.status, t.priority, t.type,
  t.projects_json AS projectsJson, t.revision,
  t.archived_at AS archivedAt,
  t.created_at AS createdAt, t.updated_at AS updatedAt,
  t.planned_start_at AS plannedStartAt, t.planned_end_at AS plannedEndAt,
  t.actual_start_at AS actualStartAt, t.actual_end_at AS actualEndAt,
  (SELECT COUNT(*) FROM task_activities a WHERE a.task_id = t.id) AS activityCount,
  (SELECT a.body FROM task_activities a WHERE a.task_id = t.id AND a.kind = 'note' ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1) AS latestNote
`;

const ACTIVITY_SELECT = `
  id, task_id AS taskId, kind, from_status AS fromStatus, to_status AS toStatus, body, created_at AS createdAt
`;

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

export function localDay(date) {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value;
}

function text(value, label, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`${label}格式无效或超出长度限制`);
  return value.trim();
}

function choice(value, choices, label) {
  if (!choices.includes(value)) throw new Error(`${label}无效`);
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label}无效`);
  return value;
}

function instant(value) {
  if (typeof value !== 'string' || !INSTANT.test(value) || value.startsWith('0000-')) throw new Error('任务时间无效');
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  const calendarCheck = new Date(Date.UTC(y, m - 1, d));
  if (calendarCheck.getUTCFullYear() !== y || calendarCheck.getUTCMonth() !== m - 1 || calendarCheck.getUTCDate() !== d) {
    throw new Error('任务时间无效');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('任务时间无效');
  return date.toISOString();
}

export function normalizeTaskId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('任务 ID 无效');
  return value;
}

function calendarDay(value) {
  if (value === 'today') return value;
  if (typeof value !== 'string' || !DAY.test(value)) throw new Error('日期应为 YYYY-MM-DD 或 today');
  instant(`${value}T00:00:00.000Z`);
  return value;
}

function normalizeProjects(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('关联项目必须是数组');
  if (value.length > 16) throw new Error('单个任务最多关联 16 个项目');
  const seen = new Set();
  const projects = [];
  for (const item of value) {
    const clean = text(item, '关联项目名称', 80);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push(clean);
  }
  return projects;
}

function parseProjectsJson(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string' && item.trim()) : [];
  } catch {
    return [];
  }
}

function mapTaskRow(row) {
  if (!row) return undefined;
  const { projectsJson, ...rest } = row;
  return {
    ...rest,
    projects: parseProjectsJson(projectsJson),
  };
}

function dateBoundary(day, today, next = false) {
  const midnight = new Date(`${day === 'today' ? today : day}T00:00:00`);
  if (next) midnight.setDate(midnight.getDate() + 1);
  const iso = midnight.toISOString();
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

export function normalizeQuery(value = {}) {
  const query = object(value || {}, '任务查询');
  const view = query.view === 'archive' ? 'archive' : 'board';
  const archived = query.archived === undefined
    ? (view === 'archive' ? 'archived' : 'active')
    : choice(query.archived, ARCHIVE_MODES, '归档范围');
  const status = query.status === undefined || query.status === ''
    ? undefined
    : choice(query.status, TASK_STATUSES, '任务状态');
  const type = query.type === undefined || query.type === ''
    ? undefined
    : choice(query.type, TASK_TYPES, '任务类型');
  const project = query.project === undefined || query.project === ''
    ? undefined
    : text(query.project, '关联项目', 80);
  const search = query.search === undefined || query.search === ''
    ? undefined
    : text(query.search, '搜索关键词', 120);
  const dateField = choice(query.dateField ?? 'createdAt', TASK_DATE_FIELDS, '日期字段');
  const from = query.from === undefined || query.from === '' ? undefined : calendarDay(query.from);
  const to = query.to === undefined || query.to === '' ? undefined : calendarDay(query.to);
  const limit = integer(query.limit ?? 48, 1, MAX_PAGE_SIZE, '单页任务数');
  const offset = integer(query.offset ?? 0, 0, Number.MAX_SAFE_INTEGER - MAX_PAGE_SIZE, '任务分页位置');
  return { view, archived, status, type, project, search, dateField, from, to, limit, offset };
}

function normalizeFields(value, partial = false) {
  const source = object(value, '任务字段');
  const fields = {};
  if (!partial || Object.hasOwn(source, 'title')) {
    fields.title = text(source.title, '任务标题', 160);
    if (!fields.title) throw new Error('请输入任务标题');
  }
  if (!partial || Object.hasOwn(source, 'details')) fields.details = text(source.details ?? '', '任务详情', 4_000);
  if (!partial || Object.hasOwn(source, 'status')) fields.status = choice(source.status ?? 'todo', TASK_STATUSES, '任务状态');
  if (!partial || Object.hasOwn(source, 'priority')) fields.priority = choice(source.priority ?? 'normal', TASK_PRIORITIES, '任务优先级');
  if (!partial || Object.hasOwn(source, 'type')) fields.type = choice(source.type ?? 'chore', TASK_TYPES, '任务类型');
  if (!partial || Object.hasOwn(source, 'projects')) fields.projects = normalizeProjects(source.projects);
  for (const key of SCHEDULE_FIELDS) {
    if (!partial || Object.hasOwn(source, key)) fields[key] = source[key] == null ? null : instant(source[key]);
  }
  return fields;
}

function applyMigration(db, version) {
  if (version === 0) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        details TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'blocked', 'done')),
        priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        type TEXT NOT NULL DEFAULT 'chore' CHECK (type IN ('feature', 'bug', 'improvement', 'chore')),
        projects_json TEXT NOT NULL DEFAULT '[]',
        planned_start_at TEXT,
        planned_end_at TEXT,
        actual_start_at TEXT,
        actual_end_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE TABLE IF NOT EXISTS task_activities (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('created', 'status_changed', 'note', 'archived', 'restored', 'reopened')),
        from_status TEXT,
        to_status TEXT,
        body TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at DESC, id);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS tasks_archived_status ON tasks(archived_at, status, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS tasks_type ON tasks(type, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS tasks_actual_end ON tasks(actual_end_at DESC, id);
      CREATE INDEX IF NOT EXISTS task_activities_task ON task_activities(task_id, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS task_activities_created ON task_activities(created_at DESC, id);
      PRAGMA user_version = ${DATABASE_VERSION};
      COMMIT;
    `);
    return;
  }

  if (version === 1) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE tasks ADD COLUMN type TEXT NOT NULL DEFAULT 'chore' CHECK (type IN ('feature', 'bug', 'improvement', 'chore'));
      ALTER TABLE tasks ADD COLUMN projects_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE tasks ADD COLUMN archived_at TEXT;
      CREATE TABLE IF NOT EXISTS task_activities (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('created', 'status_changed', 'note', 'archived', 'restored', 'reopened')),
        from_status TEXT,
        to_status TEXT,
        body TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS tasks_archived_status ON tasks(archived_at, status, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS tasks_type ON tasks(type, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS tasks_actual_end ON tasks(actual_end_at DESC, id);
      CREATE INDEX IF NOT EXISTS task_activities_task ON task_activities(task_id, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS task_activities_created ON task_activities(created_at DESC, id);
      PRAGMA user_version = ${DATABASE_VERSION};
      COMMIT;
    `);
    return;
  }

  // Handle databases created during an earlier v2 draft that lacked `projects_json`.
  const columns = db.prepare('PRAGMA table_info(tasks)').all().map((col) => col.name);
  if (!columns.includes('projects_json')) {
    db.exec("ALTER TABLE tasks ADD COLUMN projects_json TEXT NOT NULL DEFAULT '[]';");
  }
}

function inRange(iso, startIso, endIso) {
  return Boolean(iso && iso >= startIso && iso < endIso);
}

function formatDayShort(iso) {
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()}`;
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
    db.exec('PRAGMA foreign_keys = ON');
    applyMigration(db, version);
  } catch (error) {
    db.close();
    throw error;
  }

  const findTaskStmt = db.prepare(`SELECT ${TASK_SELECT} FROM tasks t WHERE t.id = ?`);
  const insertTaskStmt = db.prepare(`
    INSERT INTO tasks (
      id, title, details, status, priority, type, projects_json,
      planned_start_at, planned_end_at, actual_start_at, actual_end_at,
      archived_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const updateTaskStmt = db.prepare(`
    UPDATE tasks
    SET title = ?, details = ?, status = ?, priority = ?, type = ?, projects_json = ?,
        planned_start_at = ?, planned_end_at = ?, actual_start_at = ?, actual_end_at = ?,
        updated_at = ?, revision = revision + 1
    WHERE id = ? AND revision = ?
  `);
  const insertActivityStmt = db.prepare(`
    INSERT INTO task_activities (id, task_id, kind, from_status, to_status, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const listActivitiesByTaskStmt = db.prepare(`
    SELECT ${ACTIVITY_SELECT} FROM task_activities WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 500
  `);
  const allTasksStmt = db.prepare(`SELECT ${TASK_SELECT} FROM tasks t ORDER BY t.created_at DESC, t.rowid DESC`);
  const allActivitiesStmt = db.prepare(`SELECT ${ACTIVITY_SELECT} FROM task_activities ORDER BY created_at ASC, rowid ASC`);
  const allProjectsStmt = db.prepare("SELECT projects_json AS projectsJson FROM tasks WHERE projects_json != '[]'");

  function inTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  }

  function findTask(id) {
    return mapTaskRow(findTaskStmt.get(id));
  }

  function counts() {
    const row = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM tasks WHERE archived_at IS NULL) AS active,
        (SELECT COUNT(*) FROM tasks WHERE archived_at IS NULL AND status = 'done') AS doneActive,
        (SELECT COUNT(*) FROM tasks WHERE archived_at IS NOT NULL) AS archived
    `).get();
    return {
      active: row.active,
      doneActive: row.doneActive,
      archived: row.archived,
    };
  }

  function allProjects() {
    const names = new Map();
    for (const row of allProjectsStmt.all()) {
      for (const project of parseProjectsJson(row.projectsJson)) {
        const key = project.toLowerCase();
        if (!names.has(key)) names.set(key, project);
      }
    }
    return [...names.values()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  function query(raw = {}) {
    const { archived, status, type, project, search, dateField, from, to, limit, offset } = normalizeQuery(raw);
    const conditions = [];
    const values = [];
    if (archived === 'active') conditions.push('t.archived_at IS NULL');
    else if (archived === 'archived') conditions.push('t.archived_at IS NOT NULL');

    if (status) {
      conditions.push('t.status = ?');
      values.push(status);
    }
    if (type) {
      conditions.push('t.type = ?');
      values.push(type);
    }
    if (project) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(t.projects_json) WHERE lower(value) = lower(?))');
      values.push(project);
    }
    if (search) {
      const escaped = search.replace(/[\\%_]/g, '\\$&');
      conditions.push("(t.title LIKE ? ESCAPE '\\' OR t.details LIKE ? ESCAPE '\\' OR t.projects_json LIKE ? ESCAPE '\\')");
      values.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
    }
    if (from || to) {
      const column = DATE_COLUMNS.get(dateField);
      if (!column) throw new Error('日期字段无效');
      const today = localDay(now());
      if (from && to && (from === 'today' ? today : from) > (to === 'today' ? today : to)) {
        throw new Error('查询结束日期需晚于或等于开始日期');
      }
      if (from) {
        conditions.push(`${column} >= ?`);
        values.push(dateBoundary(from, today));
      }
      if (to) {
        conditions.push(`${column} < ?`);
        values.push(dateBoundary(to, today, true));
      }
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM tasks t${where}`).get(...values);
    const orderBy = archived === 'archived'
      ? 'COALESCE(t.actual_end_at, t.archived_at, t.updated_at) DESC, t.rowid DESC'
      : 't.created_at DESC, t.rowid DESC';
    const tasks = db.prepare(`SELECT ${TASK_SELECT} FROM tasks t${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...values, limit, offset)
      .map(mapTaskRow);
    const end = offset + tasks.length;
    return {
      tasks,
      total,
      nextOffset: end < total ? end : null,
      counts: counts(),
      allProjects: allProjects(),
    };
  }

  function autoAdjustTimestamps(current, fields, time) {
    const next = { ...current, ...fields };
    const statusChanged = current ? next.status !== current.status : true;
    const explicitStart = Object.hasOwn(fields, 'actualStartAt');
    const explicitEnd = Object.hasOwn(fields, 'actualEndAt');

    if (statusChanged) {
      if (next.status === 'in_progress' && !explicitStart && !next.actualStartAt) {
        next.actualStartAt = time;
      }
      if (next.status === 'done' && !explicitEnd && !next.actualEndAt) {
        next.actualEndAt = next.actualStartAt && next.actualStartAt > time ? next.actualStartAt : time;
      }
      if (current && current.status === 'done' && next.status !== 'done' && !explicitEnd) {
        next.actualEndAt = null;
      }
    }
    return next;
  }

  function insertOneTask(input, time) {
    const source = object(input, '新增任务');
    const id = source.id ? normalizeTaskId(source.id) : randomUUID();
    const rawFields = source.fields ?? source;
    const fields = normalizeFields(rawFields, false);
    const initialNote = rawFields.note === undefined || rawFields.note === null || rawFields.note === ''
      ? ''
      : text(rawFields.note, '初始进展内容', 1_000);
    const existing = findTask(id);
    if (existing) return existing;
    const next = autoAdjustTimestamps(null, fields, time);
    const schedule = scheduleValues(next);
    const result = insertTaskStmt.run(
      id, next.title, next.details, next.status, next.priority, next.type,
      JSON.stringify(next.projects),
      ...schedule, time, time,
    );
    if (result.changes > 0) {
      insertActivityStmt.run(randomUUID(), id, 'created', null, next.status, '', time);
      if (initialNote) {
        insertActivityStmt.run(randomUUID(), id, 'note', null, null, initialNote, time);
      }
    }
    return findTask(id);
  }

  function createTask(input) {
    const time = now().toISOString();
    return inTransaction(() => insertOneTask(input, time));
  }

  function createTasks(items) {
    if (!Array.isArray(items) || !items.length) throw new Error('请提供至少一条要创建的任务');
    if (items.length > 25) throw new Error('单次最多批量创建 25 条任务');
    const time = now().toISOString();
    return inTransaction(() => items.map((item) => insertOneTask(item, time)));
  }

  function updateTask(input) {
    const source = object(input, '更新任务');
    const id = normalizeTaskId(source.id);
    const rawFields = source.fields ?? source;
    const fields = normalizeFields(rawFields, true);
    const noteBody = rawFields.note === undefined || rawFields.note === null || rawFields.note === ''
      ? ''
      : text(rawFields.note, '进展内容', 1_000);
    if (!Object.keys(fields).length && !noteBody) throw new Error('请提供要修改的任务字段');
    const expectedRevision = source.revision === undefined || source.revision === null
      ? null
      : integer(source.revision, 1, Number.MAX_SAFE_INTEGER, '任务版本');
    const time = now().toISOString();
    return inTransaction(() => {
      const current = findTask(id);
      if (!current) throw new Error('任务不存在');
      const targetRevision = expectedRevision ?? current.revision;
      if (current.revision !== targetRevision) throw new Error('任务已被更新，请重新打开任务后再保存');
      const next = autoAdjustTimestamps(current, fields, time);
      const schedule = scheduleValues(next);
      const result = updateTaskStmt.run(
        next.title, next.details, next.status, next.priority, next.type,
        JSON.stringify(next.projects),
        ...schedule, time, id, targetRevision,
      );
      if (result.changes === 0) throw new Error('任务已被更新，请重新打开任务后再保存');
      if (next.status !== current.status) {
        insertActivityStmt.run(randomUUID(), id, 'status_changed', current.status, next.status, '', time);
      }
      if (noteBody) {
        insertActivityStmt.run(randomUUID(), id, 'note', null, null, noteBody, time);
      }
      return findTask(id);
    });
  }

  function getDetail(id) {
    const normalizedId = normalizeTaskId(id);
    const task = findTask(normalizedId);
    if (!task) throw new Error('任务不存在');
    return {
      task,
      activities: listActivitiesByTaskStmt.all(normalizedId),
    };
  }

  function addNote(taskId, body) {
    const id = normalizeTaskId(taskId);
    const clean = text(body, '进展内容', 1_000);
    if (!clean) throw new Error('请输入进展记录内容');
    const time = now().toISOString();
    return inTransaction(() => {
      const current = findTask(id);
      if (!current) throw new Error('任务不存在');
      const activityId = randomUUID();
      insertActivityStmt.run(activityId, id, 'note', null, null, clean, time);
      db.prepare('UPDATE tasks SET updated_at = ?, revision = revision + 1 WHERE id = ?').run(time, id);
      const activities = listActivitiesByTaskStmt.all(id);
      return {
        task: findTask(id),
        activity: activities.find((item) => item.id === activityId),
        activities,
      };
    });
  }

  function deleteNote(taskId, activityId) {
    const id = normalizeTaskId(taskId);
    const noteId = normalizeTaskId(activityId);
    const time = now().toISOString();
    return inTransaction(() => {
      const current = findTask(id);
      if (!current) throw new Error('任务不存在');
      const result = db.prepare("DELETE FROM task_activities WHERE id = ? AND task_id = ? AND kind = 'note'")
        .run(noteId, id);
      if (result.changes === 0) throw new Error('进展记录不存在或不可删除');
      db.prepare('UPDATE tasks SET updated_at = ?, revision = revision + 1 WHERE id = ?').run(time, id);
      return {
        task: findTask(id),
        activities: listActivitiesByTaskStmt.all(id),
      };
    });
  }

  function archiveTask(id, revision) {
    const normalizedId = normalizeTaskId(id);
    const rev = integer(revision, 1, Number.MAX_SAFE_INTEGER, '任务版本');
    const time = now().toISOString();
    return inTransaction(() => {
      const current = findTask(normalizedId);
      if (!current) throw new Error('任务不存在');
      if (current.revision !== rev) throw new Error('任务已被更新，请刷新后再试');
      if (current.archivedAt) return { task: current };
      const result = db.prepare(`
        UPDATE tasks SET archived_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ? AND archived_at IS NULL
      `).run(time, normalizedId, rev);
      if (result.changes === 0) throw new Error('任务已被更新，请刷新后再试');
      insertActivityStmt.run(randomUUID(), normalizedId, 'archived', current.status, current.status, '', time);
      return { task: findTask(normalizedId) };
    });
  }

  function archiveDone() {
    const time = now().toISOString();
    return inTransaction(() => {
      const targets = db.prepare("SELECT id FROM tasks WHERE status = 'done' AND archived_at IS NULL").all();
      const archivedIds = [];
      for (const row of targets) {
        const result = db.prepare(`
          UPDATE tasks SET archived_at = ?, revision = revision + 1
          WHERE id = ? AND status = 'done' AND archived_at IS NULL
        `).run(time, row.id);
        if (result.changes > 0) {
          insertActivityStmt.run(randomUUID(), row.id, 'archived', 'done', 'done', '', time);
          archivedIds.push(row.id);
        }
      }
      return { archivedCount: archivedIds.length, archivedIds };
    });
  }

  function restoreTask(id, revision) {
    const normalizedId = normalizeTaskId(id);
    const rev = integer(revision, 1, Number.MAX_SAFE_INTEGER, '任务版本');
    const time = now().toISOString();
    return inTransaction(() => {
      const current = findTask(normalizedId);
      if (!current) throw new Error('任务不存在');
      if (current.revision !== rev) throw new Error('任务已被更新，请刷新后再试');
      if (!current.archivedAt) return { task: current };
      const result = db.prepare(`
        UPDATE tasks SET archived_at = NULL, revision = revision + 1
        WHERE id = ? AND revision = ?
      `).run(normalizedId, rev);
      if (result.changes === 0) throw new Error('任务已被更新，请刷新后再试');
      insertActivityStmt.run(randomUUID(), normalizedId, 'restored', current.status, current.status, '', time);
      return { task: findTask(normalizedId) };
    });
  }

  function reopenTask(id, revision, targetStatus = 'in_progress') {
    const normalizedId = normalizeTaskId(id);
    const rev = integer(revision, 1, Number.MAX_SAFE_INTEGER, '任务版本');
    const status = choice(targetStatus ?? 'in_progress', ['todo', 'in_progress'], '重开状态');
    const time = now().toISOString();
    return inTransaction(() => {
      const current = findTask(normalizedId);
      if (!current) throw new Error('任务不存在');
      if (current.revision !== rev) throw new Error('任务已被更新，请刷新后再试');
      const nextActualStart = status === 'in_progress' && !current.actualStartAt ? time : current.actualStartAt;
      const result = db.prepare(`
        UPDATE tasks
        SET archived_at = NULL, status = ?, actual_start_at = ?, actual_end_at = NULL,
            updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
      `).run(status, nextActualStart, time, normalizedId, rev);
      if (result.changes === 0) throw new Error('任务已被更新，请刷新后再试');
      insertActivityStmt.run(randomUUID(), normalizedId, 'reopened', current.status, status, '', time);
      return { task: findTask(normalizedId) };
    });
  }

  function deleteTask(id, revision) {
    const normalizedId = normalizeTaskId(id);
    const rev = integer(revision, 1, Number.MAX_SAFE_INTEGER, '任务版本');
    const result = db.prepare('DELETE FROM tasks WHERE id = ? AND revision = ?').run(normalizedId, rev);
    if (result.changes === 0) throw new Error('任务不存在或版本已变化');
    return { deleted: true, id: normalizedId };
  }

  function summarizePeriod(args = {}) {
    const today = localDay(now());
    const fromDay = args.from ? calendarDay(args.from) : today;
    const toDay = args.to ? calendarDay(args.to) : fromDay;
    const resolvedFrom = fromDay === 'today' ? today : fromDay;
    const resolvedTo = toDay === 'today' ? today : toDay;
    if (resolvedFrom > resolvedTo) throw new Error('查询结束日期需晚于或等于开始日期');
    const filterProject = args.project ? text(args.project, '关联项目', 80).toLowerCase() : '';
    const filterType = args.type ? choice(args.type, TASK_TYPES, '任务类型') : '';

    const startIso = dateBoundary(resolvedFrom, today);
    const endIso = dateBoundary(resolvedTo, today, true);
    const includesToday = resolvedFrom <= today && today <= resolvedTo;

    const allTasks = allTasksStmt.all().map(mapTaskRow).filter((task) => {
      if (filterType && task.type !== filterType) return false;
      if (filterProject && !task.projects.some((p) => p.toLowerCase() === filterProject)) return false;
      return true;
    });
    const taskById = new Map(allTasks.map((task) => [task.id, task]));
    const periodActivities = allActivitiesStmt.all()
      .filter((item) => taskById.has(item.taskId) && inRange(item.createdAt, startIso, endIso));

    const activitiesByTask = new Map();
    const notesByTask = new Map();
    for (const item of periodActivities) {
      const list = activitiesByTask.get(item.taskId) || [];
      list.push(item);
      activitiesByTask.set(item.taskId, list);
      if (item.kind === 'note' && item.body) {
        const notes = notesByTask.get(item.taskId) || [];
        notes.push({ date: formatDayShort(item.createdAt), createdAt: item.createdAt, body: item.body });
        notesByTask.set(item.taskId, notes);
      }
    }

    const completedIds = new Set();
    for (const task of allTasks) {
      if (inRange(task.actualEndAt, startIso, endIso)) completedIds.add(task.id);
    }
    for (const [taskId, items] of activitiesByTask.entries()) {
      const task = taskById.get(taskId);
      let finished = false;
      for (const item of items) {
        if (item.kind === 'status_changed' && item.toStatus === 'done') finished = true;
        else if (item.kind === 'reopened' || (item.kind === 'status_changed' && item.fromStatus === 'done' && item.toStatus !== 'done')) {
          finished = false;
        }
      }
      if (finished && (!task.actualEndAt || inRange(task.actualEndAt, startIso, endIso))) {
        completedIds.add(taskId);
      }
    }

    const progressedIds = new Set();
    for (const [taskId, items] of activitiesByTask.entries()) {
      if (completedIds.has(taskId)) continue;
      const meaningful = items.some((item) => (
        item.kind === 'note'
        || item.kind === 'reopened'
        || (item.kind === 'status_changed' && (item.toStatus === 'in_progress' || item.toStatus === 'blocked'))
        || (item.kind === 'created' && item.toStatus === 'in_progress')
      ));
      if (meaningful) progressedIds.add(taskId);
    }
    for (const task of allTasks) {
      if (!completedIds.has(task.id) && !progressedIds.has(task.id) && inRange(task.actualStartAt, startIso, endIso)) {
        progressedIds.add(task.id);
      }
    }

    const blockedIds = new Set();
    if (includesToday || resolvedTo >= today) {
      for (const task of allTasks) {
        if (!task.archivedAt && task.status === 'blocked') blockedIds.add(task.id);
      }
    }
    for (const [taskId, items] of activitiesByTask.entries()) {
      const task = taskById.get(taskId);
      if (completedIds.has(taskId)) continue;
      if (items.some((item) => item.kind === 'status_changed' && item.toStatus === 'blocked')) {
        if (task.status === 'blocked' || !includesToday) blockedIds.add(taskId);
      }
    }

    const sortTasks = (list) => [...list].sort((a, b) => (
      TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
      || (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2)
      || (b.actualEndAt || b.updatedAt).localeCompare(a.actualEndAt || a.updatedAt)
    ));

    const compact = (task) => ({
      id: task.id,
      title: task.title,
      type: task.type,
      status: task.status,
      priority: task.priority,
      projects: task.projects,
      archived: Boolean(task.archivedAt),
      actualStartAt: task.actualStartAt,
      actualEndAt: task.actualEndAt,
      plannedStartAt: task.plannedStartAt,
      plannedEndAt: task.plannedEndAt,
      details: task.details || undefined,
      notes: notesByTask.get(task.id) || [],
      latestNote: task.latestNote || undefined,
    });

    const completed = sortTasks([...completedIds].map((id) => taskById.get(id)).filter(Boolean)).map(compact);
    const progressed = sortTasks([...progressedIds].map((id) => taskById.get(id)).filter(Boolean)).map(compact);
    const blocked = sortTasks([...blockedIds].map((id) => taskById.get(id)).filter(Boolean)).map(compact);
    const planned = allTasks
      .filter((task) => !task.archivedAt && (task.status === 'in_progress' || task.status === 'todo'))
      .sort((a, b) => (
        (a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1)
        || (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2)
        || (a.plannedEndAt || '9999').localeCompare(b.plannedEndAt || '9999')
      ))
      .slice(0, 12)
      .map(compact);

    const completedByType = Object.fromEntries(TASK_TYPES.map((t) => [t, 0]));
    const byProject = {};
    for (const item of [...completed, ...progressed, ...blocked]) {
      if (completedIds.has(item.id)) completedByType[item.type] += 1;
      const targets = item.projects.length ? item.projects : ['未关联项目'];
      for (const proj of targets) {
        if (!byProject[proj]) byProject[proj] = { completed: 0, progressed: 0, blocked: 0 };
        if (completedIds.has(item.id)) byProject[proj].completed += 1;
        else if (progressedIds.has(item.id)) byProject[proj].progressed += 1;
        if (blockedIds.has(item.id)) byProject[proj].blocked += 1;
      }
    }

    return {
      period: {
        from: resolvedFrom,
        to: resolvedTo,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      filters: {
        ...(args.project ? { project: args.project } : {}),
        ...(filterType ? { type: filterType } : {}),
      },
      stats: {
        completedCount: completed.length,
        progressedCount: progressed.length,
        blockedCount: blocked.length,
        plannedCount: planned.length,
        completedByType,
        byProject,
      },
      completed,
      progressed,
      blocked,
      planned,
    };
  }

  const readDataVersion = db.prepare('PRAGMA data_version');
  let knownDataVersion = readDataVersion.get().data_version;

  function hasExternalChange() {
    const nextVersion = readDataVersion.get().data_version;
    if (nextVersion === knownDataVersion) return false;
    knownDataVersion = nextVersion;
    return true;
  }

  return {
    query,
    get: (id) => findTask(normalizeTaskId(id)),
    getDetail,
    createTask,
    createTasks,
    updateTask,
    deleteTask,
    addNote,
    deleteNote,
    archiveTask,
    archiveDone,
    restoreTask,
    reopenTask,
    summarizePeriod,
    hasExternalChange,
    close: () => db.close(),
  };
}
