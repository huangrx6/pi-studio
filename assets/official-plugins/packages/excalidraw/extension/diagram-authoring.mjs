import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const emitter = fileURLToPath(new URL('./skills/excalidraw-live-canvas/scripts/emit_excalidraw.py', import.meta.url));
const presets = ['fit', 'doc-inline', 'doc-wide', 'slide-16x9', 'print-a4-landscape'];
const types = ['architecture', 'dependency', 'flow', 'state', 'network', 'mindmap'];
const maxInputBytes = 2 * 1024 * 1024;
const maxOutputBytes = 8 * 1024 * 1024;
const pythonCommands = process.platform === 'win32'
  ? [['py', '-3'], ['python3'], ['python']]
  : [['python3'], ...(process.platform === 'darwin' ? [['/opt/homebrew/bin/python3'], ['/usr/local/bin/python3']] : [])];

// Keep the original emitter as the entry point and signal an unsupported interpreter separately.
const pythonEntry = [
  'import runpy, sys',
  'if sys.version_info < (3, 10): sys.exit(78)',
  'sys.argv = sys.argv[1:]',
  'runpy.run_path(sys.argv[0], run_name="__main__")',
].join('\n');

export const authoringParameters = {
  spec: {
    type: 'object',
    description: 'The diagram-authoring specification. Use the bundled skill references for node kinds, groups, icons, styles, and port hints.',
    required: ['type', 'nodes', 'edges'],
    properties: {
      type: { enum: types },
      title: { type: 'string', maxLength: 120 },
      direction: { enum: ['LR', 'TB'] },
      nodes: {
        type: 'array', items: {
          type: 'object', required: ['id', 'label', 'kind'],
          properties: { id: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string' } },
        },
      },
      edges: {
        type: 'array', items: {
          type: 'object', required: ['from', 'to'],
          properties: { from: { type: 'string' }, to: { type: 'string' } },
        },
      },
    },
  },
  colors: { type: 'object', description: 'Optional diagram-authoring project palette from references/color-design.md.' },
  preset: { enum: presets, description: 'The diagram-authoring viewing preset. Defaults to fit.' },
  quality: { enum: ['standard', 'showcase'], description: 'Use showcase for final delivery with stricter layout checks.' },
  library: { type: 'object', description: 'Optional contents of an Excalidraw .excalidrawlib file for explicitly chosen icon names.' },
};

async function emitScene(directory, args, signal) {
  for (const [program, ...options] of pythonCommands) {
    try {
      const { stdout } = await run(program, [...options, '-I', '-B', '-X', 'utf8', '-c', pythonEntry, emitter, ...args], {
        cwd: directory,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
        maxBuffer: maxOutputBytes,
        timeout: 45_000,
        windowsHide: true,
        signal,
      });
      return JSON.parse(stdout);
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code === 'ENOENT' || error.code === 78 || error.stderr?.startsWith('xcode-select:')) continue;
      if (error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new Error('图形排版超时或超过大小上限，请缩小范围或拆成几个视图');
      }
      const detail = error.stderr?.trim().replaceAll(directory, '<diagram input>');
      throw new Error(detail?.slice(0, 4_000) || '图形排版失败，请检查 diagram-authoring 规格');
    }
  }
  throw new Error('实时绘图需要本机安装 Python 3.10 或更新版本');
}

export async function generateDiagram({ spec, colors, preset, quality, library }, signal) {
  const specification = JSON.stringify(spec);
  const palette = colors && JSON.stringify(colors);
  // An explicit library keeps the canvas self-contained, including when a spec requests a missing icon.
  const icons = JSON.stringify(library ?? { type: 'excalidrawlib', version: 2, libraryItems: [] });
  if (Buffer.byteLength(specification) + Buffer.byteLength(palette || '') + Buffer.byteLength(icons) > maxInputBytes) {
    throw new Error('图形规格和素材库合计最多 2 MB');
  }
  if (preset !== undefined && !presets.includes(preset)) throw new Error('未知的图形输出预设');
  if (quality !== undefined && !['standard', 'showcase'].includes(quality)) throw new Error('未知的图形质量档位');
  signal?.throwIfAborted();
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-studio-diagram-'));
  try {
    await writeFile(path.join(directory, 'diagram.json'), specification, { mode: 0o600 });
    await writeFile(path.join(directory, 'icons.excalidrawlib'), icons, { mode: 0o600 });
    const args = ['diagram.json', '--stdout', '--library', 'icons.excalidrawlib'];
    if (palette) {
      await writeFile(path.join(directory, 'colors.json'), palette, { mode: 0o600 });
      args.push('--colors', 'colors.json');
    }
    if (preset) args.push('--preset', preset);
    if (quality) args.push('--quality', quality);
    return await emitScene(directory, args, signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function appendDiagram(previous, generated) {
  const { elements, files, appState } = generated;
  if (!previous.elements.length) {
    return { elements, files, appState: previous.appState ?? { viewBackgroundColor: appState.viewBackgroundColor } };
  }

  const visible = previous.elements.filter(element => !element.isDeleted);
  const bottom = Math.max(0, ...visible.map(element => element.y
    + (element.points ? Math.max(...element.points.map(point => point[1])) : element.height)));
  const top = Math.min(...elements.map(element => element.y
    + (element.points ? Math.min(...element.points.map(point => point[1])) : 0)));
  const dy = bottom + 96 - top;
  const prefix = randomUUID().slice(0, 8);
  const ids = new Map(elements.map((element, index) => [element.id, `${prefix}-${index}`]));
  const groups = new Map();
  const additions = elements.map(element => {
    const next = {
      ...element, id: ids.get(element.id), y: element.y + dy,
      groupIds: (element.groupIds ?? []).map(group => {
        if (!groups.has(group)) groups.set(group, ids.get(group) ?? `${prefix}-group-${groups.size}`);
        return groups.get(group);
      }),
    };
    delete next.index;
    for (const key of ['containerId', 'frameId']) {
      if (element[key]) next[key] = ids.get(element[key]) ?? null;
    }
    for (const key of ['startBinding', 'endBinding']) {
      const binding = element[key];
      if (binding) {
        const elementId = ids.get(binding.elementId);
        next[key] = elementId ? { ...binding, elementId } : null;
      }
    }
    if (element.boundElements) {
      next.boundElements = element.boundElements
        .filter(binding => ids.has(binding.id))
        .map(binding => ({ ...binding, id: ids.get(binding.id) }));
    }
    return next;
  });
  return {
    ...previous,
    elements: [...previous.elements, ...additions],
    files: { ...previous.files, ...files },
  };
}
