import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { planDiagram } from './diagram.mjs';
import { appendDiagram, authoringParameters, generateDiagram } from './diagram-authoring.mjs';
import { MAX_ELEMENTS, MAX_SCENE_BYTES, normalizeCanvasScene } from './scene.mjs';

const idSchema = { type: 'string', pattern: '^[a-zA-Z0-9_.:-]{1,100}$' };
const boardIdSchema = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' };
const DEFAULT_BOARD_ID = 'default';
const MAX_BOARDS_PER_SESSION = 24;
const coordinate = { type: 'number', minimum: -100_000, maximum: 100_000 };
const stores = new Map();

function emptyBoard(title = '') {
  return { revision: 0, drawing: false, title, scene: { elements: [], files: {} } };
}

function sanitizeBoardId(value) {
  const text = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(text)) {
    throw new Error('画布 ID 格式无效');
  }
  return text;
}

function writeAtomic(destination, value) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const staging = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(staging, destination);
  } finally {
    rmSync(staging, { force: true });
  }
}

function readJsonFile(file, maxBytes = MAX_SCENE_BYTES + 2_048) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > maxBytes) throw new Error('画布存储无效或超过大小上限');
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function durableKey(value) {
  const key = String(value ?? '');
  return /^[1-9]\d*$/.test(key) && Number.isSafeInteger(Number(key)) ? key : '';
}

function result(text) {
  return { output: [{ type: 'text', text }] };
}

function openBoards(directory) {
  if (stores.has(directory)) return stores.get(directory);
  const sessionsDir = path.join(directory, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const live = new Map();
  const listeners = new EventEmitter();
  listeners.setMaxListeners(64);
  const legacySessionFilename = (id) => path.join(sessionsDir, `${id}.excalidraw.json`);
  const legacyRootFilename = (id) => path.join(directory, `${id}.excalidraw.json`);
  const indexFilename = (id) => path.join(sessionsDir, `${id}.boards.json`);
  const boardDir = (id) => path.join(sessionsDir, id);
  const boardFilename = (id, boardId) => path.join(boardDir(id), `${boardId}.excalidraw.json`);
  const liveKey = (id, boardId) => `${id}:${boardId}`;

  function readSavedBoard(id, boardId) {
    const primary = boardFilename(id, boardId);
    const candidates = boardId === DEFAULT_BOARD_ID
      ? [primary, legacySessionFilename(id), legacyRootFilename(id)]
      : [primary];
    const targetFile = candidates.find((file) => existsSync(file));
    if (!targetFile) return emptyBoard();
    return readJsonFile(targetFile) ?? emptyBoard();
  }

  function readIndex(id) {
    const raw = readJsonFile(indexFilename(id), 128 * 1024);
    if (raw && Array.isArray(raw.boards) && raw.boards.length > 0) {
      const boards = [];
      const seen = new Set();
      for (const entry of raw.boards) {
        if (!entry || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id) || seen.has(entry.id)) continue;
        seen.add(entry.id);
        boards.push({
          id: entry.id,
          title: typeof entry.title === 'string' ? entry.title.slice(0, 120) : '',
          updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
        });
      }
      if (boards.length > 0) {
        const activeBoardId = seen.has(raw.activeBoardId) ? raw.activeBoardId : boards[0].id;
        return { activeBoardId, boards };
      }
    }
    const legacy = readSavedBoard(id, DEFAULT_BOARD_ID);
    return {
      activeBoardId: DEFAULT_BOARD_ID,
      boards: [{ id: DEFAULT_BOARD_ID, title: typeof legacy.title === 'string' ? legacy.title : '', updatedAt: 0 }],
    };
  }

  function saveIndex(id, index) {
    writeAtomic(indexFilename(id), JSON.stringify(index));
    return index;
  }

  function readBoardState(id, boardId) {
    return live.get(liveKey(id, boardId)) ?? readSavedBoard(id, boardId);
  }

  function summarizeBoards(id, index) {
    return index.boards.map((entry) => {
      const state = readBoardState(id, entry.id);
      const elements = Array.isArray(state.scene?.elements) ? state.scene.elements : [];
      return {
        id: entry.id,
        title: typeof state.title === 'string' && state.title ? state.title : entry.title || '',
        revision: Number.isSafeInteger(state.revision) ? state.revision : 0,
        elementCount: elements.filter((element) => !element?.isDeleted).length,
        updatedAt: entry.updatedAt || 0,
        drawing: Boolean(state.drawing),
      };
    });
  }

  function read(id, requestedBoardId) {
    if (!id) {
      return {
        boardId: DEFAULT_BOARD_ID,
        activeBoardId: DEFAULT_BOARD_ID,
        boards: [{ id: DEFAULT_BOARD_ID, title: '', revision: 0, elementCount: 0, updatedAt: 0, drawing: false }],
        ...emptyBoard(),
      };
    }
    const index = readIndex(id);
    const targetBoardId = requestedBoardId ? sanitizeBoardId(requestedBoardId) : index.activeBoardId;
    if (requestedBoardId && !index.boards.some((entry) => entry.id === targetBoardId)) {
      throw new Error('目标画布不存在');
    }
    const board = readBoardState(id, targetBoardId);
    const boards = summarizeBoards(id, index);
    return {
      boardId: targetBoardId,
      activeBoardId: index.activeBoardId,
      boards,
      revision: Number.isSafeInteger(board.revision) ? board.revision : 0,
      drawing: Boolean(board.drawing),
      title: typeof board.title === 'string' ? board.title : '',
      scene: board.scene || { elements: [], files: {} },
      ...(board.playback ? { playback: board.playback } : {}),
    };
  }

  function publish(id, payload = read(id)) {
    listeners.emit(id, { viewData: payload });
  }

  function setLive(id, boardId, board, activate = true) {
    const index = readIndex(id);
    const exists = index.boards.some((entry) => entry.id === boardId);
    const nextTitle = typeof board.title === 'string' ? board.title.slice(0, 120) : '';
    const nextBoards = exists
      ? index.boards.map((entry) => (entry.id === boardId ? { ...entry, title: nextTitle || entry.title } : entry))
      : [...index.boards, { id: boardId, title: nextTitle, updatedAt: Date.now() }];
    if (nextBoards.length > MAX_BOARDS_PER_SESSION) {
      throw new Error(`单个会话最多创建 ${MAX_BOARDS_PER_SESSION} 个画布，请删除旧画布后再试`);
    }
    saveIndex(id, {
      activeBoardId: activate ? boardId : index.activeBoardId,
      boards: nextBoards,
    });
    live.set(liveKey(id, boardId), board);
    return read(id, boardId);
  }

  function clearLive(id, boardId) {
    return live.delete(liveKey(id, boardId));
  }

  function save(id, boardId, board, { activate = false } = {}) {
    const targetBoardId = sanitizeBoardId(boardId);
    const current = readSavedBoard(id, targetBoardId);
    if ((current.revision ?? 0) !== board.revision - 1) {
      throw new Error('画布版本已变化，请读取最新版本后重试');
    }
    const persisted = {
      revision: board.revision,
      drawing: false,
      title: typeof board.title === 'string' ? board.title.slice(0, 120) : '',
      scene: board.scene,
    };
    const value = JSON.stringify(persisted);
    if (Buffer.byteLength(value) > MAX_SCENE_BYTES + 1_024 || persisted.scene.elements.length > MAX_ELEMENTS) {
      throw new Error('画布超出大小上限，请拆分图形或压缩图片后再保存');
    }
    writeAtomic(boardFilename(id, targetBoardId), value);
    const index = readIndex(id);
    const exists = index.boards.some((entry) => entry.id === targetBoardId);
    const now = Date.now();
    const nextBoards = exists
      ? index.boards.map((entry) => (entry.id === targetBoardId ? { ...entry, title: persisted.title, updatedAt: now } : entry))
      : [...index.boards, { id: targetBoardId, title: persisted.title, updatedAt: now }];
    saveIndex(id, {
      activeBoardId: activate ? targetBoardId : index.activeBoardId,
      boards: nextBoards,
    });
    clearLive(id, targetBoardId);
    return read(id, activate ? targetBoardId : undefined);
  }

  function selectBoard(id, boardId) {
    const targetBoardId = sanitizeBoardId(boardId);
    const index = readIndex(id);
    if (!index.boards.some((entry) => entry.id === targetBoardId)) {
      throw new Error('目标画布不存在');
    }
    saveIndex(id, { ...index, activeBoardId: targetBoardId });
    const view = read(id, targetBoardId);
    publish(id, view);
    return view;
  }

  function createBoard(id, { title = '', boardId, activate = true } = {}) {
    const index = readIndex(id);
    if (index.boards.length >= MAX_BOARDS_PER_SESSION) {
      throw new Error(`单个会话最多创建 ${MAX_BOARDS_PER_SESSION} 个画布，请删除旧画布后再试`);
    }
    const targetBoardId = boardId ? sanitizeBoardId(boardId) : randomUUID();
    if (index.boards.some((entry) => entry.id === targetBoardId)) {
      throw new Error('目标画布已存在');
    }
    const cleanTitle = String(title ?? '').trim().slice(0, 120);
    const initial = emptyBoard(cleanTitle);
    writeAtomic(boardFilename(id, targetBoardId), JSON.stringify(initial));
    const nextIndex = {
      activeBoardId: activate ? targetBoardId : index.activeBoardId,
      boards: [...index.boards, { id: targetBoardId, title: cleanTitle, updatedAt: Date.now() }],
    };
    saveIndex(id, nextIndex);
    const view = read(id, nextIndex.activeBoardId);
    publish(id, view);
    return view;
  }

  function renameBoard(id, boardId, title) {
    const targetBoardId = sanitizeBoardId(boardId);
    const index = readIndex(id);
    if (!index.boards.some((entry) => entry.id === targetBoardId)) {
      throw new Error('目标画布不存在');
    }
    const cleanTitle = String(title ?? '').trim().slice(0, 120);
    const current = readSavedBoard(id, targetBoardId);
    const updated = { ...current, title: cleanTitle };
    writeAtomic(boardFilename(id, targetBoardId), JSON.stringify(updated));
    const liveEntry = live.get(liveKey(id, targetBoardId));
    if (liveEntry) live.set(liveKey(id, targetBoardId), { ...liveEntry, title: cleanTitle });
    saveIndex(id, {
      ...index,
      boards: index.boards.map((entry) => (entry.id === targetBoardId ? { ...entry, title: cleanTitle, updatedAt: Date.now() } : entry)),
    });
    const view = read(id);
    publish(id, view);
    return view;
  }

  function deleteBoard(id, boardId) {
    const targetBoardId = sanitizeBoardId(boardId);
    const index = readIndex(id);
    const pos = index.boards.findIndex((entry) => entry.id === targetBoardId);
    if (pos === -1) throw new Error('目标画布不存在');
    const state = readBoardState(id, targetBoardId);
    if (state.drawing) throw new Error('画布正在绘制中，暂时无法删除');
    if (index.boards.length === 1) {
      const current = readSavedBoard(id, targetBoardId);
      const reset = { revision: (current.revision ?? 0) + 1, drawing: false, title: '', scene: { elements: [], files: {} } };
      writeAtomic(boardFilename(id, targetBoardId), JSON.stringify(reset));
      saveIndex(id, { activeBoardId: targetBoardId, boards: [{ id: targetBoardId, title: '', updatedAt: Date.now() }] });
      const view = read(id, targetBoardId);
      publish(id, view);
      return view;
    }
    rmSync(boardFilename(id, targetBoardId), { force: true });
    if (targetBoardId === DEFAULT_BOARD_ID) {
      rmSync(legacySessionFilename(id), { force: true });
      rmSync(legacyRootFilename(id), { force: true });
    }
    const remaining = index.boards.filter((entry) => entry.id !== targetBoardId);
    const nextActiveId = index.activeBoardId === targetBoardId
      ? remaining[Math.max(0, pos - 1)].id
      : index.activeBoardId;
    saveIndex(id, { activeBoardId: nextActiveId, boards: remaining });
    const view = read(id, nextActiveId);
    publish(id, view);
    return view;
  }

  function waitForSubscriber(id, signal, timeoutMs = 1_400) {
    if (listeners.listenerCount(id) > 0) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason || new Error('Aborted'));
        return;
      }
      const onNew = (eventName) => {
        if (eventName !== id) return;
        cleanup();
        resolve(true);
      };
      const onAbort = () => {
        cleanup();
        reject(signal.reason || new Error('Aborted'));
      };
      // Drawing awaits this timeout even when the view never subscribes.
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        listeners.off('newListener', onNew);
        signal?.removeEventListener('abort', onAbort);
      }
      listeners.on('newListener', onNew);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  const store = {
    live,
    listeners,
    read,
    readIndex,
    saveIndex,
    publish,
    setLive,
    clearLive,
    save,
    selectBoard,
    createBoard,
    renameBoard,
    deleteBoard,
    waitForSubscriber,
  };
  stores.set(directory, store);
  return store;
}

function drawTool(boards, { revealPanel }) {
  return {
    name: 'excalidraw_draw',
    description: 'Preferred tool whenever creating or updating any Excalidraw diagram in Pi Studio (architecture, flow, dependency, state, network topology, mind map). Automatically opens the Excalidraw tab in the floating tools panel and animates drawing shapes, labels, and connections stroke-by-stroke in front of the user. Pass boardId or mode="new" to draw a separate diagram without overwriting an existing board. Do not use bash scripts to write standalone .excalidraw files instead of calling this tool unless the user explicitly asks only for an exported file on disk.',
    executionMode: 'sequential',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...authoringParameters,
        boardId: boardIdSchema,
        title: { type: 'string', maxLength: 120 },
        mode: { enum: ['append', 'replace', 'new'] },
        revision: { type: 'integer', minimum: 0 },
        layout: { enum: ['architecture', 'dependency', 'flow', 'state', 'network', 'mindmap'] },
        direction: { enum: ['TB', 'LR'] },
        nodes: {
          type: 'array', maxItems: 48, items: {
            type: 'object', required: ['id', 'label'], additionalProperties: false,
            properties: {
              id: idSchema,
              label: { type: 'string', minLength: 1, maxLength: 120 },
              shape: { enum: ['rectangle', 'diamond', 'ellipse'] },
              color: { enum: ['neutral', 'blue', 'teal', 'purple', 'amber'] },
              x: coordinate, y: coordinate,
            },
          },
        },
        edges: {
          type: 'array', maxItems: 72, items: {
            type: 'object', required: ['from', 'to'], additionalProperties: false,
            properties: {
              from: idSchema, to: idSchema,
              label: { type: 'string', maxLength: 60 },
              directed: { type: 'boolean' },
              dashed: { type: 'boolean' },
            },
          },
        },
      },
    },
    async execute(args, api, context) {
      const id = durableKey(api.conversationId);
      if (!id) throw new Error('Open a conversation before drawing.');
      const sessionView = boards.read(id);
      if (sessionView.boards.some((entry) => entry.drawing)) {
        throw new Error('The canvas already has a drawing in progress.');
      }
      const explicitTitle = args.spec?.title?.trim() || args.title?.trim() || '';
      const requestedBoardId = args.boardId ? sanitizeBoardId(args.boardId) : '';
      let targetBoardId = requestedBoardId || sessionView.activeBoardId || DEFAULT_BOARD_ID;
      let isCreating = false;
      if (args.mode === 'new') {
        isCreating = true;
        if (requestedBoardId && sessionView.boards.some((entry) => entry.id === requestedBoardId)) {
          throw new Error('Target board already exists.');
        }
        targetBoardId = requestedBoardId || randomUUID();
      } else if (requestedBoardId) {
        if (!sessionView.boards.some((entry) => entry.id === requestedBoardId)) {
          throw new Error('Target board does not exist.');
        }
      } else {
        const activeSummary = sessionView.boards.find((entry) => entry.id === targetBoardId);
        const shouldAutoCreate = args.mode !== 'append'
          && args.mode !== 'replace'
          && (activeSummary?.elementCount ?? 0) > 0
          && Boolean(explicitTitle)
          && explicitTitle !== (activeSummary?.title || '')
          && !(args.edges?.length);
        if (shouldAutoCreate) {
          isCreating = true;
          targetBoardId = randomUUID();
        }
      }

      const previousIndex = boards.readIndex(id);
      const before = isCreating ? emptyBoard(explicitTitle) : boards.read(id, targetBoardId);
      if ((args.revision !== undefined && args.revision !== before.revision)
        || (args.mode === 'replace' && before.scene.elements.length && args.revision !== before.revision)) {
        throw new Error('Read the current canvas revision before replacing or updating it.');
      }
      const replacing = args.mode === 'replace' || isCreating;
      const scene = replacing ? emptyBoard().scene : before.scene;
      const title = explicitTitle || before.title;
      const board = { revision: before.revision, drawing: true, title, scene: before.scene };
      const signal = context?.abortSignal;
      signal?.throwIfAborted();
      boards.setLive(id, targetBoardId, board, true);
      try {
        const hadSubscriber = boards.listeners.listenerCount(id) > 0;
        const subscriberWait = hadSubscriber ? Promise.resolve(false) : boards.waitForSubscriber(id, signal, 1_400);
        revealPanel?.('board', Number(id));
        boards.publish(id);

        const legacyGroups = args.spec ? undefined : planDiagram(args, scene.elements);
        const generated = args.spec
          ? appendDiagram(scene, await generateDiagram(args, signal))
          : { ...scene, elements: [...scene.elements, ...legacyGroups.flat()] };
        const target = normalizeCanvasScene(generated);
        if (target.elements.length > MAX_ELEMENTS || Buffer.byteLength(JSON.stringify(target)) > MAX_SCENE_BYTES) {
          throw new Error('画布超出大小上限，请把图拆成几个视图再绘制');
        }

        const waitedForOpen = await subscriberWait;
        signal?.throwIfAborted();
        const firstElement = scene.elements.length;
        const added = target.elements.length - firstElement;
        if (added > 0) {
          const leadInMs = waitedForOpen || !hadSubscriber ? 550 : 280;
          const durationMs = Math.min(16_000, Math.max(1_650, added * 390));
          const playback = { startAt: Date.now() + leadInMs, durationMs, firstElement };
          const live = { ...board, scene: target, playback };
          boards.setLive(id, targetBoardId, live, true);
          boards.publish(id);
          await delay(leadInMs + durationMs + 120, undefined, { signal });
        }

        signal?.throwIfAborted();
        const saved = boards.save(id, targetBoardId, {
          ...board, revision: before.revision + 1, drawing: false, scene: target,
        }, { activate: true });
        boards.publish(id, saved);
        const { nodes = [], edges = [] } = args.spec ?? args;
        return result(`Excalidraw canvas "${saved.title || saved.boardId}" updated (boardId: ${saved.boardId}, revision ${saved.revision}). ${nodes.length} nodes and ${edges.length} connections drawn. Total boards in session: ${saved.boards.length}.`);
      } finally {
        if (boards.clearLive(id, targetBoardId)) {
          boards.saveIndex(id, previousIndex);
          boards.publish(id);
        }
      }
    },
  };
}

function readTool(boards) {
  return {
    name: 'excalidraw_read',
    description: 'Read an Excalidraw diagram and session board list before continuing. Returns boardId, activeBoardId, boards, revision, labels, node IDs, positions, and connections.',
    replay: 'safe',
    parameters: {
      type: 'object',
      properties: { boardId: boardIdSchema },
      additionalProperties: false,
    },
    async execute(args, api) {
      const board = boards.read(durableKey(api.conversationId), args?.boardId);
      const elements = board.scene.elements.filter(element => !element.isDeleted);
      const textByContainer = new Map(elements.filter(element => element.type === 'text' && element.containerId)
        .map(element => [element.containerId, element.text]));
      return result(JSON.stringify({
        boardId: board.boardId,
        activeBoardId: board.activeBoardId,
        boards: board.boards,
        title: board.title,
        revision: board.revision,
        drawing: board.drawing,
        nodes: elements.filter(element => ['rectangle', 'ellipse', 'diamond'].includes(element.type))
          .slice(0, 128).map(({ id, type, x, y, width, height }) => ({
            id, type, x, y, width, height, label: textByContainer.get(id)?.slice(0, 160) || '',
          })),
        edges: elements.filter(element => element.type === 'arrow').slice(0, 160)
          .map(({ id, startBinding, endBinding }) => ({
            from: startBinding?.elementId, to: endBinding?.elementId, label: textByContainer.get(id)?.slice(0, 80),
          })),
      }));
    },
  };
}

export function activate(context) {
  const { dataDirectory } = context;
  const boards = openBoards(dataDirectory);
  return {
    durableExtension: { name: 'studio.excalidraw', tools: [drawTool(boards, context), readTool(boards)] },
    dataSources: {
      scene: {
        read: ({ durableSessionId }) => ({ viewData: boards.read(durableKey(durableSessionId)) }),
        subscribe({ durableSessionId }, publish) {
          const id = durableKey(durableSessionId);
          if (!id) return;
          const board = boards.read(id);
          boards.listeners.on(id, publish);
          publish({ viewData: board });
          return () => boards.listeners.off(id, publish);
        },
        invoke({ durableSessionId, signal }, method, params) {
          signal?.throwIfAborted();
          const id = durableKey(durableSessionId);
          if (!id) throw new Error('请先打开一个聊天');
          if (method === 'save') {
            const revision = params?.revision;
            if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('画布版本无效');
            const targetBoardId = params?.boardId
              ? sanitizeBoardId(params.boardId)
              : boards.readIndex(id).activeBoardId;
            const scene = normalizeCanvasScene(params?.scene);
            const before = boards.read(id, targetBoardId);
            if (before.drawing || before.revision !== revision) throw new Error('画布正在更新，请读取最新版本后重试');
            const title = typeof params?.title === 'string' ? params.title.trim().slice(0, 120) : before.title;
            const saved = boards.save(id, targetBoardId, { ...before, title, revision: revision + 1, scene }, {
              activate: targetBoardId === boards.readIndex(id).activeBoardId,
            });
            boards.publish(id);
            return saved;
          }
          if (method === 'selectBoard') return boards.selectBoard(id, params?.boardId);
          if (method === 'createBoard') return boards.createBoard(id, {
            title: params?.title,
            boardId: params?.boardId,
            activate: params?.activate !== false,
          });
          if (method === 'renameBoard') return boards.renameBoard(id, params?.boardId, params?.title);
          if (method === 'deleteBoard') return boards.deleteBoard(id, params?.boardId);
          throw new Error(`未知画布操作：${method}`);
        },
      },
    },
  };
}
