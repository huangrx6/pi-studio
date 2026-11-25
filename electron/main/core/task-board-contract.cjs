'use strict';

const TASK_STATUSES = Object.freeze(['todo', 'in_progress', 'blocked', 'done']);
const TASK_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);
const SCHEDULE_FIELDS = ['plannedStartAt', 'plannedEndAt', 'actualStartAt', 'actualEndAt'];
const TASK_DATE_FIELDS = Object.freeze(['createdAt', 'updatedAt', ...SCHEDULE_FIELDS]);
const MAX_PAGE_SIZE = 100;
const TASK_FIELDS = new Set(['title', 'details', 'status', 'priority', ...SCHEDULE_FIELDS]);
const TASK_QUERY_FIELDS = new Set(['status', 'dateField', 'from', 'to', 'limit', 'offset']);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = /^(?!0000)\d{4}-\d{2}-\d{2}$/;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + '格式无效');
  return value;
}

function text(value, label, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(label + '格式无效或超出长度限制');
  return value.trim();
}

function choice(value, choices, label) {
  if (!choices.includes(value)) throw new Error(label + '无效');
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(label + '无效');
  return value;
}

function instant(value) {
  if (typeof value !== 'string' || !INSTANT.test(value) || value.startsWith('0000-')) throw new Error('任务时间无效');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error('任务时间无效');
  return value;
}

function calendarDay(value) {
  if (value === 'today') return value;
  if (typeof value !== 'string' || !DAY.test(value)) throw new Error('日期应为 YYYY-MM-DD 或 today');
  instant(value + 'T00:00:00.000Z');
  return value;
}

function normalizeTaskId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('任务 ID 无效');
  return value;
}

function normalizeTaskBoardQuery(value = {}) {
  const query = object(value, '任务查询');
  if (Object.keys(query).some(key => !TASK_QUERY_FIELDS.has(key))) throw new Error('存在未知任务查询字段');
  const { status, from, to, dateField = 'createdAt', limit = 48, offset = 0 } = query;
  return {
    ...(status === undefined ? {} : { status: choice(status, TASK_STATUSES, '任务状态') }),
    ...(from === undefined ? {} : { from: calendarDay(from) }),
    ...(to === undefined ? {} : { to: calendarDay(to) }),
    dateField: choice(dateField, TASK_DATE_FIELDS, '日期字段'),
    limit: integer(limit, 1, MAX_PAGE_SIZE, '单页任务数'),
    offset: integer(offset, 0, Number.MAX_SAFE_INTEGER - MAX_PAGE_SIZE, '任务分页位置'),
  };
}

function normalizeFields(value, partial = false) {
  const source = object(value, '任务');
  const fields = {};
  if (!partial || Object.hasOwn(source, 'title')) {
    fields.title = text(source.title, '任务标题', 160);
    if (!fields.title) throw new Error('请输入任务标题');
  }
  if (!partial || Object.hasOwn(source, 'details')) fields.details = text(source.details ?? '', '任务详情', 4_000);
  if (!partial || Object.hasOwn(source, 'status')) fields.status = choice(source.status ?? 'todo', TASK_STATUSES, '任务状态');
  if (!partial || Object.hasOwn(source, 'priority')) fields.priority = choice(source.priority ?? 'normal', TASK_PRIORITIES, '任务优先级');
  for (const key of SCHEDULE_FIELDS) {
    if (!partial || Object.hasOwn(source, key)) fields[key] = source[key] == null ? null : instant(source[key]);
  }
  return fields;
}

function normalizeTaskBoardMutation(value) {
  const input = object(value, '任务操作');
  const { action, id, fields, revision } = input;
  if (action !== 'create' && action !== 'update') throw new Error('任务操作无效');
  if (Object.keys(object(fields, '任务字段')).some(key => !TASK_FIELDS.has(key))) throw new Error('存在未知任务字段');
  const task = { action, id: normalizeTaskId(id), fields: normalizeFields(fields, action === 'update') };
  if (action === 'create') return task;
  if (!Object.keys(task.fields).length) throw new Error('请提供要修改的任务字段');
  return { ...task, revision: integer(revision, 1, Number.MAX_SAFE_INTEGER, '任务版本') };
}

function normalizeTaskBoardTask(value) {
  const task = object(value, '任务');
  return {
    id: normalizeTaskId(task.id),
    revision: integer(task.revision, 1, Number.MAX_SAFE_INTEGER, '任务版本'),
    ...normalizeFields(task),
    createdAt: instant(task.createdAt),
    updatedAt: instant(task.updatedAt),
  };
}

function normalizeTaskBoardSnapshot(value) {
  const snapshot = object(value, '任务看板');
  if (!Array.isArray(snapshot.tasks) || snapshot.tasks.length > MAX_PAGE_SIZE) throw new Error('任务看板超出单页限制');
  const tasks = snapshot.tasks.map(normalizeTaskBoardTask);
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('任务看板包含重复 ID');
  const total = integer(snapshot.total, tasks.length, Number.MAX_SAFE_INTEGER, '任务总数');
  const nextOffset = snapshot.nextOffset == null ? null : integer(snapshot.nextOffset, 1, total - 1, '任务分页位置');
  return { tasks, total, nextOffset };
}

const taskBoardProtocol = Object.freeze({
  version: 1,
  statuses: TASK_STATUSES,
  dateFields: TASK_DATE_FIELDS,
  maxPageSize: MAX_PAGE_SIZE,
  normalizeId: normalizeTaskId,
  normalizeQuery: normalizeTaskBoardQuery,
});

module.exports = { taskBoardProtocol, normalizeTaskBoardMutation, normalizeTaskBoardSnapshot, normalizeTaskBoardTask };
