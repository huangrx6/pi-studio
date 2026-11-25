import { openTaskStore } from './store.mjs';

function jsonResult(value) {
  return { output: [{ type: 'text', text: JSON.stringify(value) }] };
}

function taskTools(store, protocol) {
  const day = { type: 'string', description: 'Local calendar date: YYYY-MM-DD or today.' };
  return [
    {
      name: 'task_board_list',
      description: 'Query the global Task Board by status and inclusive local calendar dates. Set dateField to createdAt (default), updatedAt, plannedStartAt, plannedEndAt, actualStartAt or actualEndAt. Use from and to with the same date or today for a single day. Follow nextOffset for more results. Use task_board_get for full details.',
      replay: 'safe',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: [...protocol.statuses] },
          dateField: { type: 'string', enum: [...protocol.dateFields] },
          from: day,
          to: day,
          limit: { type: 'integer', minimum: 1, maximum: protocol.maxPageSize, default: 20 },
          offset: { type: 'integer', minimum: 0 },
        },
      },
      async execute(args) {
        const query = protocol.normalizeQuery({ limit: 20, ...args });
        const page = store.query(query);
        // Keep list results compact. Individual tasks expose their full text through get.
        const tasks = page.tasks.map(({ details, revision, ...task }) => task);
        return jsonResult({ ...page, tasks, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      },
    },
    {
      name: 'task_board_get',
      description: 'Read the full details and planned/actual timestamps of a global Task Board task by its ID.',
      replay: 'safe',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', format: 'uuid' } },
        required: ['id'],
      },
      async execute({ id }) {
        const task = store.get(protocol.normalizeId(id));
        if (!task) throw new Error('任务不存在');
        return jsonResult(task);
      },
    },
  ];
}

export function activate({ dataDirectory, taskBoard }) {
  if (taskBoard?.version !== 1) throw new Error('当前 Studio 版本不支持任务看板协议');
  const store = openTaskStore(dataDirectory);
  const subscribers = new Set();
  const snapshot = ({ taskBoardQuery }) => ({ taskBoard: store.query(taskBoard.normalizeQuery(taskBoardQuery)) });
  return {
    durableExtension: { name: 'studio.task-board', tools: taskTools(store, taskBoard) },
    dataSources: {
      'board-data': {
        read: snapshot,
        subscribe(context, publish) {
          const refresh = () => { if (!context.signal?.aborted) publish(snapshot(context)); };
          refresh();
          subscribers.add(refresh);
          return () => subscribers.delete(refresh);
        },
        writeTaskBoard(context, mutation) {
          context.signal?.throwIfAborted();
          const saved = store.write(mutation);
          for (const refresh of subscribers) {
            try { refresh(); }
            catch { /* A failed refresh does not undo a committed task. */ }
          }
          return saved;
        },
      },
    },
    cleanup() {
      subscribers.clear();
      store.close();
    },
  };
}
