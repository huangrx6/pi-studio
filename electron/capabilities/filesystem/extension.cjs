/** Read-only workspace discovery and search tools. */

const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const toolSchema = require('../../runtime/tool-schema.cjs');

const MAX_GREP_PATTERN_LENGTH = 512;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const MAX_GREP_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_GREP_LINE_CHARACTERS = 8_192;
const DEFAULT_GREP_TIMEOUT_MS = 2_000;

const GREP_WORKER_SOURCE = String.raw`
const fs = require('node:fs/promises');
const fsConstants = require('node:fs').constants;
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

(async () => {
  const {
    files,
    root,
    pattern,
    glob,
    limit,
    maxFileBytes,
    maxTotalBytes,
    maxLineCharacters,
  } = workerData;
  let matcher;
  try {
    matcher = new RegExp(pattern, 'i');
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      message: '无效的正则表达式：' + (error instanceof Error ? error.message : String(error)),
    });
    return;
  }
  const lines = [];
  let scannedBytes = 0;
  let skippedLongLines = 0;
  let budgetReached = false;
  for (const file of files) {
    if (glob && !file.toLowerCase().includes(glob)) continue;
    let text;
    let handle;
    try {
      handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (stat.size > maxFileBytes) continue;
      if (scannedBytes + stat.size > maxTotalBytes) {
        budgetReached = true;
        break;
      }
      scannedBytes += stat.size;
      text = await handle.readFile('utf8');
    } catch {
      continue;
    } finally {
      await handle?.close().catch(() => {});
    }
    if (text.includes('\u0000')) continue;
    const rows = text.split(/\r?\n/);
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index].length > maxLineCharacters) {
        skippedLongLines += 1;
        continue;
      }
      matcher.lastIndex = 0;
      if (!matcher.test(rows[index])) continue;
      lines.push(path.relative(root, file) + ':' + (index + 1) + ':' + rows[index]);
      if (lines.length >= limit) break;
    }
    if (lines.length >= limit) break;
  }
  parentPort.postMessage({
    type: 'result',
    lines,
    skippedLongLines,
    budgetReached,
  });
})().catch((error) => {
  parentPort.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  });
});
`;

function runGrepWorker(options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(GREP_WORKER_SOURCE, {
      eval: true,
      workerData: {
        files: options.files,
        root: options.root,
        pattern: options.pattern,
        glob: options.glob,
        limit: options.limit,
        maxFileBytes: MAX_GREP_FILE_BYTES,
        maxTotalBytes: MAX_GREP_TOTAL_BYTES,
        maxLineCharacters: MAX_GREP_LINE_CHARACTERS,
      },
    });
    let settled = false;
    const timeout = setTimeout(() => {
      settle(new Error(`搜索正则执行超过 ${options.timeoutMs}ms，已终止本次匹配`));
    }, options.timeoutMs);
    timeout.unref?.();

    function cleanup() {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }

    function settle(error, result) {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      if (error) reject(error);
      else resolve(result);
    }

    function onAbort() {
      settle(options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error('搜索已取消'));
    }

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (message) => {
      if (message?.type === 'result') {
        settle(undefined, message);
      } else {
        settle(new Error(message?.message || '搜索线程执行失败'));
      }
    });
    worker.on('error', (error) => settle(error));
    worker.on('exit', (code) => {
      if (!settled && code !== 0) settle(new Error(`搜索线程异常退出：${code}`));
    });
  });
}

function insideCwd(cwd, requested = '.') {
  const root = path.resolve(cwd || process.cwd());
  const target = path.resolve(root, requested || '.');
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('路径必须位于当前工作区内');
  }
  return target;
}

async function resolveWorkspacePath(cwd, requested = '.') {
  const lexicalRoot = path.resolve(cwd || process.cwd());
  const lexicalTarget = insideCwd(lexicalRoot, requested);
  const root = await fs.realpath(lexicalRoot);
  const target = await fs.realpath(lexicalTarget);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('路径的真实位置必须位于当前工作区内');
  }
  return { root, target };
}

async function walkFiles(root, requested, options = {}) {
  const resolved = await resolveWorkspacePath(root, requested);
  const start = resolved.target;
  const maxEntries = Math.min(5_000, Math.max(1, Number(options.maxResults) || 500));
  const includeHidden = Boolean(options.hidden);
  const results = [];
  const pending = [start];
  const maximumDirectories = Math.min(20_000, Math.max(1_000, maxEntries * 4));
  let directoryIndex = 0;
  while (
    directoryIndex < pending.length
    && directoryIndex < maximumDirectories
    && results.length < maxEntries
  ) {
    const directory = pending[directoryIndex];
    directoryIndex += 1;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(directory, entry.name);
      // Search tools never follow links. This keeps reads inside the declared
      // workspace even if a link changes between discovery and opening.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(full);
      else if (
        entry.isFile()
        && (typeof options.accept !== 'function' || options.accept(full))
      ) results.push(full);
      if (results.length >= maxEntries) break;
    }
  }
  return results;
}

function createFilesystemTools(durable, piAi, options = {}) {
  const { defineExtension, defineTool } = durable;
  const Type = toolSchema;
  const ls = defineTool({
    name: 'ls',
    description: 'List files and directories in the current workspace.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Directory relative to the workspace. Defaults to .' })),
    }),
    replay: 'safe',
    async execute(args, api, context) {
      if (!api.env) throw new Error('工作区文件系统不可用');
      const result = await api.env.listDir(args.path || '.', context);
      if (!result.ok) throw result.error;
      const lines = result.value
        .sort((left, right) => (
          Number(right.kind === 'directory') - Number(left.kind === 'directory')
          || left.name.localeCompare(right.name)
        ))
        .map((entry) => `${entry.kind === 'directory' ? 'd' : entry.kind === 'symlink' ? 'l' : '-'} ${entry.name}`);
      return { output: [{ type: 'text', text: lines.join('\n') || '(empty)' }] };
    },
  });

  const find = defineTool({
    name: 'find',
    description: 'Find files under the current workspace by name.',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Case-insensitive name filter.' })),
      path: Type.Optional(Type.String({ description: 'Directory relative to the workspace. Defaults to .' })),
      maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 5000 })),
    }),
    replay: 'safe',
    async execute(args, api, context) {
      const cwd = (await api.agent(context)).cwd || process.cwd();
      const workspace = await resolveWorkspacePath(cwd, '.');
      const query = String(args.query || '').trim().toLowerCase();
      const limit = Math.min(5_000, Math.max(1, Number(args.maxResults) || 500));
      const files = await walkFiles(workspace.root, args.path || '.', {
        hidden: true,
        maxResults: limit,
        accept: (file) => (
          !query
          || path.relative(workspace.root, file).toLowerCase().includes(query)
        ),
      });
      const output = files
        .map((file) => path.relative(workspace.root, file))
        .slice(0, limit);
      return { output: [{ type: 'text', text: output.join('\n') || 'No matching files.' }] };
    },
  });

  const grep = defineTool({
    name: 'grep',
    description: 'Search text files in the current workspace.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Regular expression to search for.' }),
      path: Type.Optional(Type.String({ description: 'File or directory relative to the workspace.' })),
      glob: Type.Optional(Type.String({ description: 'Optional file-name substring filter.' })),
      maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
    }),
    replay: 'safe',
    async execute(args, api, context) {
      const root = (await api.agent(context)).cwd || process.cwd();
      const pattern = String(args.pattern || '');
      if (!pattern) throw new Error('搜索正则不能为空');
      if (pattern.length > MAX_GREP_PATTERN_LENGTH) {
        throw new Error(`搜索正则不能超过 ${MAX_GREP_PATTERN_LENGTH} 个字符`);
      }
      const requested = args.path || '.';
      const resolved = await resolveWorkspacePath(root, requested);
      const absolute = resolved.target;
      const info = await fs.stat(absolute);
      const files = info.isDirectory()
        ? await walkFiles(
          resolved.root,
          path.relative(resolved.root, absolute) || '.',
          { hidden: true, maxResults: 5_000 },
        )
        : [absolute];
      try {
        new RegExp(pattern, 'i');
      } catch (error) {
        throw new Error(`无效的正则表达式：${error instanceof Error ? error.message : String(error)}`);
      }
      const limit = Math.min(1_000, Math.max(1, Number(args.maxResults) || 200));
      const glob = String(args.glob || '').toLowerCase();
      const result = await runGrepWorker({
        files,
        root: resolved.root,
        pattern,
        glob,
        limit,
        timeoutMs: Math.min(
          10_000,
          Math.max(100, Number(options.grepTimeoutMs) || DEFAULT_GREP_TIMEOUT_MS),
        ),
        signal: context?.abortSignal,
      });
      const notes = [
        ...(result.skippedLongLines > 0
          ? [`Skipped ${result.skippedLongLines} line${result.skippedLongLines === 1 ? '' : 's'} longer than ${MAX_GREP_LINE_CHARACTERS} characters.`]
          : []),
        ...(result.budgetReached
          ? [`Stopped after ${MAX_GREP_TOTAL_BYTES} bytes; narrow the path or glob for complete results.`]
          : []),
      ];
      const output = [result.lines.join('\n') || 'No matches.', ...notes].filter(Boolean).join('\n');
      return { output: [{ type: 'text', text: output }] };
    },
  });

  return defineExtension({
    name: 'studio-filesystem-tools',
    tools: [ls, find, grep],
  });
}

module.exports = {
  createFilesystemTools,
  resolveWorkspacePath,
  walkFiles,
};
