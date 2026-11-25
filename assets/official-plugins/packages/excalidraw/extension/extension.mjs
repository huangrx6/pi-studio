import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, renameSync, rmSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { planDiagram } from './diagram.mjs';
import { appendDiagram, authoringParameters, generateDiagram } from './diagram-authoring.mjs';

const MAX_SCENE_BYTES = 8 * 1024 * 1024;
const MAX_ELEMENTS = 1_000;
const idSchema = { type: 'string', pattern: '^[a-zA-Z0-9_.:-]{1,100}$' };
const coordinate = { type: 'number', minimum: -100_000, maximum: 100_000 };
const stores = new Map();

function emptyBoard() {
  return { revision: 0, drawing: false, title: '', scene: { elements: [], files: {} } };
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
  const live = new Map();
  const listeners = new EventEmitter();
  listeners.setMaxListeners(64);
  const filename = (id) => path.join(directory, `${id}.excalidraw.json`);

  function readSaved(id) {
    const file = filename(id);
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.size > MAX_SCENE_BYTES + 1_024) throw new Error('画布存储无效或超过大小上限');
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyBoard();
      throw error;
    }
  }

  function read(id) {
    return id ? live.get(id) ?? readSaved(id) : emptyBoard();
  }

  function publish(id, board) {
    listeners.emit(id, { canvas: board });
  }

  function save(id, board) {
    if (readSaved(id).revision !== board.revision - 1) {
      throw new Error('画布版本已变化，请读取最新版本后重试');
    }
    const value = JSON.stringify(board);
    if (Buffer.byteLength(value) > MAX_SCENE_BYTES + 1_024 || board.scene.elements.length > MAX_ELEMENTS) {
      throw new Error('画布超出大小上限，请拆分图形或压缩图片后再保存');
    }
    const destination = filename(id);
    const staging = `${destination}.${randomUUID()}.tmp`;
    try {
      writeFileSync(staging, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      renameSync(staging, destination);
    } finally {
      rmSync(staging, { force: true });
    }
    return board;
  }

  const store = { live, listeners, read, publish, save };
  stores.set(directory, store);
  return store;
}

function drawTool(boards, { revealPanel, canvasPlaybackVersion, normalizeCanvasScene }) {
  return {
    name: 'excalidraw_draw',
    description: 'Open the Excalidraw sidebar and draw an editable diagram from the bundled diagram-authoring skill. Pass its full specification as spec. Append by default. Replace only at the user’s request after reading the revision. To connect to an existing element, read the canvas and use the top-level nodes and edges with its element IDs.',
    executionMode: 'sequential',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...authoringParameters,
        title: { type: 'string', maxLength: 120 },
        mode: { enum: ['append', 'replace'] },
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
      const before = boards.read(id);
      if (before.drawing) throw new Error('The canvas already has a drawing in progress.');
      if ((args.revision !== undefined && args.revision !== before.revision)
        || (args.mode === 'replace' && before.scene.elements.length && args.revision !== before.revision)) {
        throw new Error('Read the current canvas revision before replacing or updating it.');
      }
      const replacing = args.mode === 'replace';
      const scene = replacing ? emptyBoard().scene : before.scene;
      const title = args.spec?.title?.trim() || args.title?.trim() || before.title;
      const board = { revision: before.revision, drawing: true, title, scene: before.scene };
      const signal = context?.abortSignal;
      signal?.throwIfAborted();
      boards.live.set(id, board);
      try {
        revealPanel?.('board', Number(id));
        boards.publish(id, board);

        const legacyGroups = args.spec ? undefined : planDiagram(args, scene.elements);
        const generated = args.spec
          ? appendDiagram(scene, await generateDiagram(args, signal))
          : { ...scene, elements: [...scene.elements, ...legacyGroups.flat()] };
        const target = normalizeCanvasScene ? normalizeCanvasScene(generated) : generated;
        if (target.elements.length > MAX_ELEMENTS || Buffer.byteLength(JSON.stringify(target)) > MAX_SCENE_BYTES) {
          throw new Error('画布超出大小上限，请把图拆成几个视图再绘制');
        }

        const firstElement = scene.elements.length;
        const added = target.elements.length - firstElement;
        if (canvasPlaybackVersion === 1) {
          const leadInMs = 280;
          const durationMs = Math.min(16_000, Math.max(1_650, added * 390));
          const playback = { startAt: Date.now() + leadInMs, durationMs, firstElement };
          const live = { ...board, scene: target, playback };
          boards.live.set(id, live);
          boards.publish(id, live);
          await delay(leadInMs + durationMs, undefined, { signal });
        } else {
          const groups = legacyGroups ?? target.elements.slice(firstElement).map(element => [element]);
          const batchSize = Math.max(1, Math.ceil(groups.length / 16));
          let count = firstElement;
          for (let index = 0; index < groups.length; index += batchSize) {
            count += groups.slice(index, index + batchSize).reduce((sum, group) => sum + group.length, 0);
            await delay(185, undefined, { signal });
            const live = { ...board, scene: { ...target, elements: target.elements.slice(0, count) } };
            boards.live.set(id, live);
            boards.publish(id, live);
          }
        }

        signal?.throwIfAborted();
        const saved = boards.save(id, {
          ...board, revision: before.revision + 1, drawing: false, scene: target,
        });
        boards.live.delete(id);
        boards.publish(id, saved);
        const { nodes = [], edges = [] } = args.spec ?? args;
        return result(`Excalidraw canvas updated (revision ${saved.revision}). ${nodes.length} nodes and ${edges.length} connections drawn.`);
      } finally {
        if (boards.live.delete(id)) boards.publish(id, before);
      }
    },
  };
}

function readTool(boards) {
  return {
    name: 'excalidraw_read',
    description: 'Read the current Excalidraw sidebar diagram before continuing. Returns its revision, labels, node IDs, positions, and connections.',
    replay: 'safe',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_args, api) {
      const board = boards.read(durableKey(api.conversationId));
      const elements = board.scene.elements.filter(element => !element.isDeleted);
      const textByContainer = new Map(elements.filter(element => element.type === 'text' && element.containerId)
        .map(element => [element.containerId, element.text]));
      return result(JSON.stringify({
        title: board.title, revision: board.revision, drawing: board.drawing,
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
  const { dataDirectory, canvasVersion } = context;
  if (canvasVersion !== 1) throw new Error('当前 Studio 版本不支持此插件的画布协议');
  const boards = openBoards(dataDirectory);
  return {
    durableExtension: { name: 'studio.excalidraw', tools: [drawTool(boards, context), readTool(boards)] },
    dataSources: {
      scene: {
        read: ({ durableSessionId }) => ({ canvas: boards.read(durableKey(durableSessionId)) }),
        subscribe({ durableSessionId }, publish) {
          const id = durableKey(durableSessionId);
          if (!id) return;
          const board = boards.read(id);
          boards.listeners.on(id, publish);
          publish({ canvas: board });
          return () => boards.listeners.off(id, publish);
        },
        writeCanvas({ durableSessionId, signal }, { revision, scene }) {
          signal?.throwIfAborted();
          const id = durableKey(durableSessionId);
          if (!id) throw new Error('请先打开一个聊天');
          const before = boards.read(id);
          if (before.drawing || before.revision !== revision) throw new Error('画布正在更新，请读取最新版本后重试');
          const saved = boards.save(id, { ...before, revision: revision + 1, scene });
          boards.publish(id, saved);
          return saved;
        },
      },
    },
  };
}
