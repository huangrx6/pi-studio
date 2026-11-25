import { watch } from 'node:fs';
import {
  ARCHIVE_MODES,
  MAX_PAGE_SIZE,
  TASK_DATE_FIELDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  openTaskStore,
} from './store.mjs';

function jsonResult(value) {
  return { output: [{ type: 'text', text: JSON.stringify(value) }] };
}

function taskFieldProperties(titleRequired = false) {
  return {
    title: { type: 'string', maxLength: 160, description: titleRequired ? 'Task title (required).' : 'Updated task title.' },
    details: { type: 'string', maxLength: 4000 },
    status: { type: 'string', enum: [...TASK_STATUSES] },
    priority: { type: 'string', enum: [...TASK_PRIORITIES] },
    type: { type: 'string', enum: [...TASK_TYPES] },
    projects: {
      type: 'array',
      maxItems: 16,
      items: { type: 'string', maxLength: 80 },
      description: 'Linked project names (multi-project allowed).',
    },
    plannedStartAt: { type: ['string', 'null'], description: 'ISO-8601 date-time with timezone (or null to clear).' },
    plannedEndAt: { type: ['string', 'null'], description: 'ISO-8601 date-time with timezone (or null to clear).' },
    actualStartAt: { type: ['string', 'null'], description: 'ISO-8601 date-time with timezone (or null to clear).' },
    actualEndAt: { type: ['string', 'null'], description: 'ISO-8601 date-time with timezone (or null to clear).' },
    note: { type: 'string', maxLength: 1000, description: 'Optional progress note added atomically to the timeline.' },
  };
}

function taskTools(store, onMutated) {
  const day = { type: 'string', description: 'Local calendar date: YYYY-MM-DD or today.' };
  const singleCreateProps = taskFieldProperties(true);
  return [
    {
      name: 'task_board_list',
      description: 'Query the global Task Board by status, type (feature, bug, improvement, chore), linked project name, archive state (active, archived, all), search keyword, and inclusive local calendar dates. Set dateField to createdAt (default), updatedAt, archivedAt, plannedStartAt, plannedEndAt, actualStartAt or actualEndAt. Follow nextOffset for more results. Use task_board_get for full details and activity logs.',
      replay: 'safe',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: [...TASK_STATUSES] },
          type: { type: 'string', enum: [...TASK_TYPES] },
          project: { type: 'string', maxLength: 80, description: 'Filter tasks linked to a specific project or integration target.' },
          archived: { type: 'string', enum: [...ARCHIVE_MODES] },
          search: { type: 'string', maxLength: 120 },
          dateField: { type: 'string', enum: [...TASK_DATE_FIELDS] },
          from: day,
          to: day,
          limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 20 },
          offset: { type: 'integer', minimum: 0 },
        },
      },
      async execute(args = {}) {
        const page = store.query({ limit: 20, ...args });
        const tasks = page.tasks.map(({ details, revision, activityCount, latestNote, ...task }) => task);
        return jsonResult({
          tasks,
          total: page.total,
          nextOffset: page.nextOffset,
          allProjects: page.allProjects,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
      },
    },
    {
      name: 'task_board_get',
      description: 'Read full task details, linked projects, planned/actual timestamps, and chronological progress notes/activity logs by task ID.',
      replay: 'safe',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
        required: ['id'],
      },
      async execute({ id }) {
        return jsonResult(store.getDetail(id));
      },
    },
    {
      name: 'task_board_summary',
      description: 'Aggregate Task Board achievements, multi-day progress notes, blockers, next plans, and project/type statistics for any inclusive local date range (YYYY-MM-DD or today). Ideal for generating daily reports, weekly reports, or cross-project status summaries. Archiving a task later never shifts its completion date.',
      replay: 'safe',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: day,
          to: day,
          project: { type: 'string', maxLength: 80, description: 'Optional linked project name filter.' },
          type: { type: 'string', enum: [...TASK_TYPES], description: 'Optional task type filter.' },
        },
      },
      async execute(args = {}) {
        return jsonResult(store.summarizePeriod(args));
      },
    },
    {
      name: 'task_board_create',
      description: 'Create one task (passing title and optional fields) or up to 25 tasks in one batch (passing tasks array) on the global Task Board. Live board views refresh automatically.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...singleCreateProps,
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 25,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: singleCreateProps,
              required: ['title'],
            },
          },
        },
      },
      async execute(args = {}) {
        if (Array.isArray(args.tasks)) {
          const created = store.createTasks(args.tasks);
          onMutated();
          return jsonResult({ createdCount: created.length, tasks: created });
        }
        const task = store.createTask(args);
        onMutated();
        return jsonResult({ createdCount: 1, task, tasks: [task] });
      },
    },
    {
      name: 'task_board_update',
      description: 'Update task fields (title, details, status, priority, type, projects, planned/actual schedule) and/or attach a progress note. Setting status to in_progress or done fills missing actual timestamps automatically.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          revision: { type: 'integer', minimum: 1 },
          ...taskFieldProperties(false),
        },
        required: ['id'],
      },
      async execute({ id, revision, ...fields }) {
        const task = store.updateTask({ id, revision, fields });
        onMutated();
        return jsonResult({ task });
      },
    },
    {
      name: 'task_board_add_note',
      description: 'Append a timestamped progress note to a task activity timeline.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', format: 'uuid' },
          body: { type: 'string', minLength: 1, maxLength: 1000 },
        },
        required: ['taskId', 'body'],
      },
      async execute({ taskId, body }) {
        const result = store.addNote(taskId, body);
        onMutated();
        return jsonResult(result);
      },
    },
    {
      name: 'task_board_archive',
      description: 'Archive a done task, batch-archive all active done tasks, restore an archived task back to done, or reopen an archived task.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['archive', 'archive_done', 'restore', 'reopen'], default: 'archive' },
          id: { type: 'string', format: 'uuid' },
          revision: { type: 'integer', minimum: 1 },
          status: { type: 'string', enum: ['todo', 'in_progress'], description: 'Target status when action is reopen.' },
        },
      },
      async execute({ action = 'archive', id, revision, status } = {}) {
        let result;
        if (action === 'archive_done') {
          result = store.archiveDone();
        } else {
          if (!id) throw new Error('请提供任务 ID');
          const rev = revision ?? store.get(id)?.revision;
          if (!rev) throw new Error('任务不存在');
          if (action === 'archive') result = store.archiveTask(id, rev);
          else if (action === 'restore') result = store.restoreTask(id, rev);
          else if (action === 'reopen') result = store.reopenTask(id, rev, status);
          else throw new Error('不支持的归档操作');
        }
        onMutated();
        return jsonResult(result);
      },
    },
  ];
}

export function activate({ dataDirectory, now }) {
  const store = openTaskStore(dataDirectory, now);
  const subscribers = new Set();
  let watcher = null;
  let watchTimer = null;

  const notifySubscribers = () => {
    for (const refresh of subscribers) {
      try { refresh(); }
      catch { /* A failed refresh does not undo a committed task. */ }
    }
  };

  const stopWatcher = () => {
    if (watchTimer) {
      clearTimeout(watchTimer);
      watchTimer = null;
    }
    if (watcher) {
      try { watcher.close(); } catch { /* ignore */ }
      watcher = null;
    }
  };

  const ensureWatcher = () => {
    if (watcher || subscribers.size === 0) return;
    try {
      watcher = watch(dataDirectory, (_eventType, filename) => {
        if (filename && !String(filename).startsWith('tasks.sqlite')) return;
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          watchTimer = null;
          try {
            if (store.hasExternalChange()) notifySubscribers();
          } catch { /* ignore transient file lock */ }
        }, 180);
      });
      watcher.on('error', () => stopWatcher());
    } catch {
      stopWatcher();
    }
  };

  const snapshot = ({ viewParams }) => ({ viewData: store.query(viewParams || {}) });

  return {
    durableExtension: { name: 'studio.task-board', tools: taskTools(store, notifySubscribers) },
    dataSources: {
      'board-data': {
        read: snapshot,
        subscribe(context, publish) {
          const refresh = () => { if (!context.signal?.aborted) publish(snapshot(context)); };
          refresh();
          subscribers.add(refresh);
          ensureWatcher();
          return () => {
            subscribers.delete(refresh);
            if (subscribers.size === 0) stopWatcher();
          };
        },
        invoke(context, method, params = {}) {
          context.signal?.throwIfAborted();
          let result;
          let shouldNotify = true;
          switch (method) {
            case 'createTask':
              result = store.createTask(params);
              break;
            case 'updateTask':
              result = store.updateTask(params);
              break;
            case 'deleteTask':
              result = store.deleteTask(params?.id, params?.revision);
              break;
            case 'getTaskDetail':
              shouldNotify = false;
              result = store.getDetail(params?.id);
              break;
            case 'addNote':
              result = store.addNote(params?.taskId, params?.body);
              break;
            case 'deleteNote':
              result = store.deleteNote(params?.taskId, params?.activityId);
              break;
            case 'archiveTask':
              result = store.archiveTask(params?.id, params?.revision);
              break;
            case 'archiveDone':
              result = store.archiveDone();
              break;
            case 'restoreTask':
              result = store.restoreTask(params?.id, params?.revision);
              break;
            case 'reopenTask':
              result = store.reopenTask(params?.id, params?.revision, params?.status);
              break;
            case 'summarizePeriod':
              shouldNotify = false;
              result = store.summarizePeriod(params);
              break;
            default:
              throw new Error(`未知任务看板方法：${method}`);
          }
          if (shouldNotify) notifySubscribers();
          return result;
        },
      },
    },
    cleanup() {
      subscribers.clear();
      stopWatcher();
      store.close();
    },
  };
}
