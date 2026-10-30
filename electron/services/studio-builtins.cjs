/**
 * Built-in Studio extensions.
 *
 * They use the same Durable extension contract as user extensions. Keeping the
 * built-ins here also makes their ownership visible in the settings catalog.
 * Each entry owns one narrow capability and uses the same dependency and
 * enable/disable lifecycle as user and project extensions.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { getSubagentConfig } = require('../core/app-settings.cjs');
const { requestPolicyConfirmation } = require('./confirmations.cjs');
const {
  evaluateToolCall,
  rememberApproval,
} = require('./mode.cjs');
const { createStudioHarnessExtension, renderSection } = require('./studio-harness.cjs');
const { skillInstructions } = require('./studio-skills.cjs');
const { createStudioTodoExtension } = require('./studio-todo.cjs');
const { createLongTaskExtension } = require('./studio-long-task.cjs');
const {
  METRICS_FOOTER_SOURCE_ID,
  METRICS_SOURCE_ID,
} = require('./metrics-runtime.cjs');
const {
  createProtocol,
  emptyRegistry,
} = require('./durable-subagent-protocol.cjs');

const BUILTIN_MANIFESTS = Object.freeze([
  {
    id: 'durable-coding-tools',
    tier: 'system',
    name: 'Durable 编码工具',
    version: '1.0.0',
    description: 'Pi Durable 官方 read、write、edit、bash 工具；可由用户扩展补充或覆盖。',
    runtimeName: 'coding-tools',
    runtimeNames: ['coding-tools'],
    permissions: ['agent.tools'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: ['read', 'write', 'edit', 'bash'].map((name) => ({ name })),
    },
  },
  {
    id: 'studio-filesystem-tools',
    tier: 'system',
    name: 'Studio 文件搜索',
    version: '1.0.0',
    description: 'Studio 提供的 ls、find、grep 只读工作区工具。',
    runtimeName: 'studio-filesystem-tools',
    runtimeNames: ['studio-filesystem-tools'],
    permissions: ['agent.tools'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: ['ls', 'find', 'grep'].map((name) => ({ name })),
    },
  },
  {
    id: 'studio-todo',
    tier: 'system',
    name: 'Studio 任务计划',
    version: '1.0.0',
    description: '为多步骤工作创建可恢复的任务计划，并在对话输入框上方持续显示进度。',
    runtimeName: 'studio-todo',
    runtimeNames: ['studio-todo'],
    permissions: ['agent.tools'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: [{ name: 'todo', description: '创建和维护当前会话的任务计划。' }],
    },
  },
  {
    id: 'studio-long-task',
    tier: 'core',
    name: 'Studio 长期目标',
    version: '1.0.0',
    description: '持久保存长期目标、完成条件与执行状态，并由 Durable GenerationTask 在目标完成或阻塞前持续执行。',
    runtimeName: 'studio-long-task',
    runtimeNames: ['studio-long-task'],
    permissions: ['agent.tools', 'agent.sections', 'agent.hooks'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: [{
        name: 'long_task',
        description: '记录长期目标的实质进展、已验证完成或阻塞原因。',
      }],
    },
  },
  {
    id: 'studio-harness',
    tier: 'system',
    name: 'Studio 编码 Harness',
    version: '1.0.0',
    description: '可检查、可覆盖的编码 Agent 系统提示词、AGENTS.md、项目文档和附加指令。',
    runtimeName: 'studio-harness',
    runtimeNames: ['studio-harness'],
    permissions: ['agent.sections'],
    requires: ['builtin:durable-coding-tools'],
    contributes: {},
  },
  {
    id: 'studio-tool-search',
    tier: 'system',
    name: 'MCP 工具发现',
    version: '1.0.0',
    description: '使用 Pi 官方 tool_search 按需发现 deferred MCP 工具；加载结果从下一次模型请求起可用。',
    runtimeName: 'tool-search',
    runtimeNames: ['tool-search'],
    permissions: ['agent.tools'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: [{ name: 'tool_search', description: '搜索并按需加载 deferred 工具。' }],
    },
  },
  {
    id: 'studio-skills',
    tier: 'system',
    name: 'Studio 技能',
    version: '1.0.0',
    description: '发现 Studio 用户级和已信任项目级 Skill，只向系统提示词提供名称、描述与路径。',
    runtimeName: 'studio-skills',
    runtimeNames: ['studio-skills'],
    permissions: ['agent.sections'],
    requires: ['builtin:studio-harness'],
    contributes: {},
  },
  {
    id: 'studio-permissions',
    tier: 'core',
    name: 'Studio 权限守卫',
    version: '1.0.0',
    description: '在 Durable ToolTask 阶段执行请求批准、帮我批准或完全权限策略。',
    runtimeName: 'studio-permissions',
    runtimeNames: ['studio-permissions'],
    permissions: ['agent.hooks'],
    requires: [],
    contributes: {},
  },
  {
    id: 'studio-subagents',
    tier: 'system',
    name: 'Studio 子 Agent',
    version: '2.0.0',
    description: '使用 Durable owned conversation、background anchor 与 reporter 管理前台和后台子 Agent。',
    runtimeName: 'studio-subagents',
    runtimeNames: ['studio-subagents'],
    permissions: ['agent.tools', 'agent.sections', 'agent.tasks'],
    requires: ['builtin:studio-permissions', 'builtin:studio-subagent-channel'],
    contributes: {
      tools: [
        { name: 'subagent', description: '运行、启动、发消息或查看拥有独立上下文的子 Agent。' },
        { name: 'subagent_stop', description: '停止指定后台子 Agent 的当前运行。' },
        { name: 'bg_wait', description: '等待自己的后台 reporter，超时不会停止子 Agent。' },
        { name: 'subagent_supervisor', description: '查看或回复子 Agent 发来的监督请求。' },
      ],
    },
  },
  {
    id: 'studio-subagent-channel',
    tier: 'system',
    name: 'Studio 子 Agent 监督通道',
    version: '1.0.0',
    description: '仅由 Studio 子 Agent 使用的父级联系通道；父 Agent 默认看不到这个 child 工具。',
    runtimeName: 'studio-subagent-channel',
    runtimeNames: ['studio-subagent-channel'],
    permissions: ['agent.tools'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: [{ name: 'contact_supervisor', description: '向创建此子 Agent 的主 Agent 发起异步确认请求。' }],
    },
  },
  {
    id: 'studio-metrics',
    tier: 'optional',
    name: 'Studio 指标',
    version: '1.0.0',
    description: '通过 Pi 官方遥测实时展示 TPS、TTFT、请求耗时、Token、成本与任务阶段。',
    runtimeName: 'studio-metrics',
    runtimeNames: ['studio-metrics'],
    permissions: ['ui.panels', 'ui.data'],
    requires: [],
    contributes: {
      panels: [
        {
          id: 'metrics-detail',
          title: '实时指标',
          description: '当前会话的模型请求和 Durable 任务指标。',
          slot: 'conversation.detail',
          size: 'regular',
          content: [{
            kind: 'dataView',
            sourceId: METRICS_SOURCE_ID,
            emptyText: '暂无指标数据',
            fallback: [{
              kind: 'emptyState',
              title: '等待首次运行',
              text: '发送消息后显示 TPS、TTFT、Token、成本与任务阶段。',
            }],
          }],
        },
        {
          id: 'metrics-footer',
          title: '实时指标摘要',
          description: '当前请求的紧凑状态、TPS、TTFT 与 Token。',
          slot: 'conversation.footer',
          size: 'compact',
          content: [{
            kind: 'dataView',
            sourceId: METRICS_FOOTER_SOURCE_ID,
            emptyText: '暂无指标',
            fallback: [{
              kind: 'text',
              text: '等待首次运行',
            }],
          }],
        },
      ],
      dataSources: [
        {
          id: 'live',
          title: '实时会话指标',
          description: '来自 Pi AI 与 Pi Durable 的无内容遥测。',
        },
        {
          id: 'summary',
          title: '实时会话指标摘要',
          description: '面向会话底部的紧凑实时指标。',
        },
      ],
    },
  },
]);

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MAX_GREP_PATTERN_LENGTH = 512;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const MAX_GREP_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_GREP_LINE_CHARACTERS = 8_192;
const DEFAULT_GREP_TIMEOUT_MS = 2_000;
const MAX_SUBAGENT_TEXT_LENGTH = 64_000;
const MAX_SUBAGENT_INSTRUCTIONS_LENGTH = 32_000;
const MAX_SUBAGENT_SUPERVISOR_LENGTH = 16_000;

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
  const { defineExtension, defineTool, Type } = { ...durable, Type: piAi.Type };
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

function createSkillsExtension(durable) {
  return durable.defineExtension({
    name: 'studio-skills',
    sections: [
      durable.section('studio-skills', (input) => {
        const cwd = input.env?.cwd || input.agent?.cwd;
        return renderSection(input, 'skills', () => (
          cwd ? skillInstructions(cwd, input.agent?.tools) : undefined
        ));
      }),
    ],
  });
}

function stricterPermission(left, right) {
  const rank = { allow: 0, ask: 1, deny: 2 };
  return rank[right.decision] > rank[left.decision] ? right : left;
}

function createPermissionsExtension(durable) {
  const protocol = createProtocol(durable);
  return durable.defineExtension({
    name: 'studio-permissions',
    hooks: [
      durable.hook(durable.ToolTask, {
        async beforeTool(call, api, context) {
          const sessionId = String(api.conversationId);
          const child = await api.snapshot(protocol.ChildContext, api.conversationId, context);
          const childEvaluation = await evaluateToolCall({
            sessionId,
            call,
            ...(child?.workspace ? { cwd: child.workspace } : {}),
          });
          // A child may run in a subdirectory while its parent policy is keyed
          // to the owning workspace. Evaluate both frames: omitting cwd resolves
          // the parent conversation workspace, while the explicit child cwd
          // catches boundaries introduced by a narrower child directory.
          const parentEvaluations = child?.parentConversationId
            ? await Promise.all([
                evaluateToolCall({
                  sessionId: String(child.parentConversationId),
                  call,
                }),
                evaluateToolCall({
                  sessionId: String(child.parentConversationId),
                  call,
                  ...(child.workspace ? { cwd: child.workspace } : {}),
                }),
              ])
            : [];
          const parentEvaluation = parentEvaluations.length
            ? parentEvaluations.reduce(stricterPermission)
            : undefined;
          const evaluation = parentEvaluation
            ? stricterPermission(childEvaluation, parentEvaluation)
            : childEvaluation;
          if (evaluation.decision === 'allow') return undefined;
          if (evaluation.decision === 'deny') {
            return {
              block: `${evaluation.hardProtection?.title || '操作被权限策略拒绝'}：${evaluation.explanation}`,
            };
          }
          const response = await requestPolicyConfirmation({
            sessionId,
            cwd: evaluation.cwd,
            tool: call.name,
            decision: evaluation.decision,
            explanation: evaluation.explanation,
            risk: evaluation.risk,
            rememberScopes: evaluation.rememberScopes,
            title: evaluation.risk?.title || '允许执行这个工具？',
            message: call.name === 'bash'
              ? `执行命令 · ${String(call.arguments?.command || '')}`
              : call.arguments?.path
                ? `${call.name} → ${String(call.arguments.path)}`
                : `${call.name}\n\n${JSON.stringify(call.arguments, null, 2).slice(0, 4_000)}`,
          });
          if (!response.accepted) return { block: '用户拒绝了这次工具调用。' };
          if (response.remember) {
            try {
              rememberApproval({
                sessionId,
                cwd: evaluation.cwd,
                remember: response.remember,
                call,
                label: `${call.name}：${evaluation.risk?.detail || '已批准'}`,
              });
            } catch (error) {
              // The tool was approved for this call. A failed convenience rule
              // must not turn the approved action into a denial.
              console.warn('Unable to remember tool approval:', error);
            }
          }
          return undefined;
        },
      }),
    ],
  });
}

function modelRef(value) {
  if (typeof value !== 'string') return undefined;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function normalizeSubagentConfig(user, project) {
  const merged = { ...(user || {}), ...(project || {}) };
  const model = typeof merged.defaultModel === 'string' ? merged.defaultModel.trim() : '';
  const thinking = THINKING_LEVELS.includes(merged.defaultThinking)
    ? merged.defaultThinking
    : '';
  const maxThinking = THINKING_LEVELS.includes(merged.maxThinking)
    ? merged.maxThinking
    : '';
  const allowedTools = Array.isArray(merged.allowedTools)
    ? [...new Set(merged.allowedTools
      .filter((name) => typeof name === 'string')
      .map((name) => name.trim())
      .filter((name) => /^[A-Za-z0-9_.:-]{1,120}$/.test(name)))]
      .slice(0, 256)
    : [];
  const bounded = (value, fallback, minimum, maximum) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= minimum && number <= maximum
      ? number
      : fallback;
  };
  const backgroundEnabled = merged.backgroundEnabled !== false;
  return {
    modelRef: modelRef(model),
    thinkingLevel: thinking || undefined,
    maxThinking: maxThinking || undefined,
    allowedTools,
    backgroundEnabled,
    defaultMode: backgroundEnabled && merged.defaultMode === 'background'
      ? 'background'
      : 'foreground',
    supervisorEnabled: backgroundEnabled && merged.supervisorEnabled !== false,
    maxConcurrent: bounded(merged.maxConcurrent, 4, 1, 16),
    maxSpawns: bounded(merged.maxSpawns, 32, 1, 100),
    waitTimeoutMs: bounded(merged.waitTimeoutMs, 30_000, 1_000, 600_000),
  };
}

function thinkingRank(level) {
  return THINKING_LEVELS.indexOf(level);
}

function throwIfAborted(context) {
  const signal = context?.abortSignal;
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw signal.reason instanceof Error ? signal.reason : new Error('子 Agent 已取消');
}

const RESERVED_SUBAGENT_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const SUBAGENT_MANAGEMENT_TOOLS = new Set([
  'subagent',
  'subagent_stop',
  'bg_wait',
  'subagent_supervisor',
  'contact_supervisor',
]);

function normalizeSubagentName(value, fallback) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name && fallback) return fallback;
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || RESERVED_SUBAGENT_NAMES.has(name)) {
    throw new Error('子 Agent 名称必须以字母开头，只能包含字母、数字、_、-，且最长 64 个字符');
  }
  return name;
}

function registryAgent(state, name) {
  return Object.hasOwn(state.agents, name) ? state.agents[name] : undefined;
}

function registryReporter(state, requestKey) {
  return Object.hasOwn(state.reporters, requestKey) ? state.reporters[requestKey] : undefined;
}

function backgroundOptions() {
  return {
    ownership: { kind: 'conversation' },
    background: true,
  };
}

function activeReporterCount(state) {
  return Object.values(state.reporters || {})
    .filter((reporter) => reporter?.active === true)
    .length;
}

/**
 * A foreground tool task is aborted together with the child conversation it
 * owns. The task may reject before its normal status write, so make a final
 * best-effort write without inheriting an already-aborted context. The child
 * projection also derives status from the owning Durable task, which keeps UI
 * state correct if this cleanup cannot commit while the task is abort-marked.
 */
async function writeSubagentStatus({
  api,
  protocol,
  parentConversationId,
  name,
  status,
  error,
  context,
}) {
  const commitContext = context?.abortSignal?.aborted
    ? { ...context, abortSignal: undefined }
    : context;
  await api.commit(async (tx) => {
    const registry = await tx.doc(protocol.Subagents, parentConversationId);
    const agent = registryAgent(registry, name);
    if (!agent) return;
    agent.lastStatus = status;
    agent.updatedAt = api.now();
    if (error) {
      agent.lastError = String(error).slice(0, 2_000);
    } else {
      delete agent.lastError;
    }
  }, commitContext);
}

function pruneReporterRegistrations(state, maximum = 256) {
  const terminal = Object.entries(state.reporters || {})
    .filter(([, reporter]) => reporter?.active !== true)
    .sort((left, right) => (
      Number(right[1]?.endedAt || right[1]?.createdAt || 0)
      - Number(left[1]?.endedAt || left[1]?.createdAt || 0)
    ));
  for (const [requestKey] of terminal.slice(maximum)) {
    delete state.reporters[requestKey];
  }
}

function childToolsFor(agent, defaults, childSupervisorTool) {
  const allowed = defaults.allowedTools.length > 0
    ? new Set(defaults.allowedTools)
    : undefined;
  const modelTools = [];
  const enabledTools = [];
  const enabledNames = new Set();
  const canExpose = (tool) => (
    tool?.name
    && !SUBAGENT_MANAGEMENT_TOOLS.has(tool.name)
    && (!allowed || allowed.has(tool.name))
  );
  const add = (target, names, tool) => {
    if (!canExpose(tool) || names.has(tool.name)) return;
    names.add(tool.name);
    target.push(tool);
  };
  const modelNames = new Set();
  for (const tool of Array.isArray(agent.tools) ? agent.tools : []) {
    add(enabledTools, enabledNames, tool);
    add(modelTools, modelNames, tool);
  }
  // agent.callable contains tools available to nested/codemode calls even when
  // the model is not offered them directly. It is an expansion of `tools`, not
  // a replacement for the model-facing filter.
  for (const tool of Array.isArray(agent.callable) ? agent.callable : []) {
    add(enabledTools, enabledNames, tool);
  }
  if (defaults.allowedTools.length > 0 && enabledTools.length === 0) {
    throw new Error(
      `子 Agent 的工具白名单与父 Agent 当前工具没有交集：${defaults.allowedTools.join(', ')}`,
    );
  }
  if (defaults.supervisorEnabled && childSupervisorTool) {
    const addSupervisorTool = (target, names) => {
      if (names.has(childSupervisorTool.name)) return;
      names.add(childSupervisorTool.name);
      target.push(childSupervisorTool);
    };
    addSupervisorTool(enabledTools, enabledNames);
    addSupervisorTool(modelTools, modelNames);
  }
  return { enabledTools, modelTools };
}

function childInstructions(name, parentConversationId, supervisorEnabled) {
  return [
    `You are Studio subagent "${name}" (parent conversation ${parentConversationId}).`,
    'Work only within the tools and workspace granted to this child conversation.',
    'Never claim to have created another subagent. Child conversations cannot spawn children.',
    ...(supervisorEnabled
      ? ['Use contact_supervisor only when parent approval or missing context blocks safe progress. The request is asynchronous; continue with independent work while awaiting a reply.']
      : []),
  ].join('\n');
}

function settingsWorkspace(agent) {
  return agent && typeof agent.cwd === 'string' ? agent.cwd : '';
}

async function resolveChildSettings(args, api, context, childSupervisorTool, piAi) {
  const agent = await api.agent(context);
  const defaults = normalizeSubagentConfig(
    getSubagentConfig('user'),
    getSubagentConfig('project', agent.cwd || ''),
  );
  const requestedModel = args.model ? modelRef(args.model) : defaults.modelRef;
  if (args.model && !requestedModel) {
    throw new Error('子 Agent 模型必须使用 provider/modelId 格式');
  }
  const requestedThinking = args.thinkingLevel || defaults.thinkingLevel;
  if (requestedThinking && !THINKING_LEVELS.includes(requestedThinking)) {
    throw new Error(`子 Agent thinking 强度无效：${requestedThinking}`);
  }
  if (
    requestedThinking
    && defaults.maxThinking
    && thinkingRank(requestedThinking) > thinkingRank(defaults.maxThinking)
  ) {
    throw new Error(`子 Agent thinking 强度不能高于 ${defaults.maxThinking}`);
  }
  const childModel = requestedModel
    ? api.models.getModel(requestedModel.provider, requestedModel.modelId)
    : undefined;
  if (requestedModel && !childModel) {
    throw new Error(`子 Agent 模型不存在或尚未启用：${args.model || defaults.modelRef.provider + '/' + defaults.modelRef.modelId}`);
  }
  if (
    childModel
    && requestedThinking
    && !piAi.getSupportedThinkingLevels(childModel).includes(requestedThinking)
  ) {
    throw new Error(`模型 ${childModel.provider}/${childModel.id} 不支持 thinking=${requestedThinking}`);
  }
  let childCwd = agent.cwd || '';
  if (args.cwd) {
    if (!agent.cwd) throw new Error('父 Agent 没有工作区，不能设置子 Agent 工作目录');
    const resolved = await resolveWorkspacePath(agent.cwd, args.cwd);
    childCwd = resolved.target;
  }
  const { enabledTools, modelTools } = childToolsFor(
    agent,
    defaults,
    childSupervisorTool,
  );
  return {
    agent,
    defaults,
    requestedModel,
    requestedThinking,
    childCwd,
    enabledTools,
    modelTools,
  };
}

async function configureChildConversation({
  tx,
  durable,
  childId,
  parentConversationId,
  name,
  anchorTaskId,
  ownerTaskId,
  mode,
  settings,
  instructions,
  parentExtension,
  childChannelExtension,
}) {
  const protocol = createProtocol(durable);
  const childExtensions = (settings.agent.extensions || [])
    .filter((extension) => (
      extension !== parentExtension
      && extension?.name !== parentExtension.name
    ));
  if (!childExtensions.some((extension) => extension?.name === childChannelExtension.name)) {
    childExtensions.push(childChannelExtension);
  }
  await durable.configure(tx, childId, {
    extensions: childExtensions,
    tools: settings.enabledTools,
    modelTools: settings.modelTools,
    ...(settings.requestedModel ? { model: settings.requestedModel } : {}),
    ...(settings.requestedThinking ? { thinkingLevel: settings.requestedThinking } : {}),
    ...(settings.childCwd && settings.childCwd !== settings.agent.cwd
      ? { cwd: settings.childCwd }
      : {}),
    ...(instructions ? { instructions } : {}),
  });
  const childContext = await tx.doc(protocol.ChildContext, childId);
  childContext.parentConversationId = parentConversationId;
  childContext.name = name;
  childContext.anchorTaskId = anchorTaskId || 0;
  childContext.workspace = settings.childCwd || settings.agent.cwd || '';
  childContext.supervisorEnabled = Boolean(settings.defaults.supervisorEnabled);
  childContext.createdAt = settings.createdAt;
  const registry = await tx.doc(protocol.Subagents, parentConversationId);
  registry.agents[name] = {
    name,
    conversationId: childId,
    anchorTaskId: anchorTaskId || 0,
    ownerTaskId: ownerTaskId || 0,
    mode,
    createdAt: settings.createdAt,
    updatedAt: settings.createdAt,
    reported: [],
    lastStatus: 'running',
  };
}

async function createReporter({
  tx,
  durable,
  parentConversationId,
  requestKey,
  name,
  conversationId,
  message,
  followUp,
  now,
  maximum,
}) {
  const protocol = createProtocol(durable);
  const registry = await tx.doc(protocol.Subagents, parentConversationId);
  const existing = registryReporter(registry, requestKey);
  if (existing) return existing;
  if (activeReporterCount(registry) >= maximum) {
    throw new Error(`后台子 Agent 已达到并发上限 ${maximum}`);
  }
  const taskId = await tx.createTask(protocol.Reporter, {
    name,
    conversationId,
    message,
    followUp: Boolean(followUp),
    requestKey,
  }, backgroundOptions());
  const record = {
    taskId,
    requestKey,
    name,
    active: true,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  };
  registry.reporters[requestKey] = record;
  pruneReporterRegistrations(registry);
  const agent = registryAgent(registry, name);
  if (agent) {
    agent.lastReporterTaskId = taskId;
    agent.updatedAt = now;
  }
  return record;
}

function createSubagentChannelExtension(durable, piAi) {
  const { defineExtension, defineTool, Type } = { ...durable, Type: piAi.Type };
  const protocol = createProtocol(durable);
  return defineExtension({
    name: 'studio-subagent-channel',
    tools: [
      defineTool({
        name: 'contact_supervisor',
        description: 'Send an asynchronous question or approval request to the parent Agent that created this child. A parent reply starts a new child turn when needed.',
        parameters: Type.Object({
          question: Type.String({ description: 'The exact decision, missing context, or approval needed from the parent.' }),
        }),
        replay: 'safe',
        async execute(args, api, context) {
          const child = await api.snapshot(protocol.ChildContext, api.conversationId, context);
          if (!child?.parentConversationId) {
            throw new Error('contact_supervisor 只能在 Studio 创建的子 Agent 中调用');
          }
          if (!child.supervisorEnabled) {
            throw new Error('当前子 Agent 没有启用父级监督通道');
          }
          const question = String(args.question || '').trim();
          if (!question || question.length > MAX_SUBAGENT_SUPERVISOR_LENGTH) {
            throw new Error(`监督问题不能为空，且不能超过 ${MAX_SUBAGENT_SUPERVISOR_LENGTH} 个字符`);
          }
          const main = await api.conversation(child.parentConversationId, context);
          if (!main) throw new Error('创建此子 Agent 的主会话不存在');
          const requestId = `supervisor:${api.taskId}`;
          const now = api.now();
          await api.commit(async (tx) => {
            const registry = await tx.doc(protocol.Subagents, child.parentConversationId);
            const agent = registryAgent(registry, child.name);
            if (!agent || agent.conversationId !== api.conversationId) {
              throw new Error('子 Agent 归属信息已经失效');
            }
            if (!Object.hasOwn(registry.supervisorRequests, requestId)) {
              const pendingForChild = Object.values(registry.supervisorRequests)
                .filter((request) => (
                  request?.status === 'pending'
                  && request.childConversationId === api.conversationId
                )).length;
              if (pendingForChild >= 4) {
                throw new Error('该子 Agent 最多同时保留 4 个待回复监督请求');
              }
              registry.supervisorRequests[requestId] = {
                requestId,
                childConversationId: api.conversationId,
                childName: child.name,
                question,
                status: 'pending',
                createdAt: now,
                updatedAt: now,
              };
              protocol.pruneSupervisorRequests(registry.supervisorRequests);
            }
          }, context);
          const submission = await main.submit({
            type: 'input',
            content: [
              '[subagent supervisor request]',
              `request: ${requestId}`,
              `child: ${child.name}`,
              `question: ${question}`,
              'Use subagent_supervisor with action "reply" when you can answer.',
            ].join('\n'),
            whenBusy: 'followUp',
            requestId: `subagent-supervisor-request:${requestId}`,
          }, context);
          return {
            output: [{
              type: 'text',
              text: `已把监督请求发给主 Agent（${requestId}）。请求是异步的；不要把它描述成同步阻塞。`,
            }],
            details: {
              supervisorRequestId: requestId,
              parentSubmissionId: String(submission.id),
            },
          };
        },
      }),
    ],
  });
}

function createSubagentExtension(durable, piAi, chordContext) {
  const { defineExtension, defineTool, Type } = { ...durable, Type: piAi.Type };
  const protocol = createProtocol(durable);
  const channel = createSubagentChannelExtension(durable, piAi);
  const childSupervisorTool = channel.tools.find((tool) => tool.name === 'contact_supervisor');

  const parentExtension = defineExtension({
    name: 'studio-subagents',
    tasks: [protocol.Anchor, protocol.Reporter],
    sections: [
      durable.section('studio-subagents', () => (
        [
          'Use subagent for self-contained parallel work. A child has its own conversation, model, thinking level, cwd, and narrower tool set.',
          'action=run waits for a foreground result. action=spawn starts a durable background child and reports its answer back as a follow-up.',
          'Use action=send to steer or follow up a named background child, bg_wait to wait for a reporter without stopping it, and subagent_stop to stop only that child.',
          'Child superagent requests arrive as supervisor follow-up messages and must be answered with subagent_supervisor.',
        ].join(' ')
      ), { tag: false }),
    ],
    tools: [
      defineTool({
        name: 'subagent',
        description: 'Run or manage one child Agent. action=run is foreground and waits for the result; spawn creates a named durable background child; send messages a background child; status lists children. use subagent_stop to stop one.',
        parameters: Type.Object({
          action: Type.Optional(Type.Union([
            Type.Literal('run'),
            Type.Literal('spawn'),
            Type.Literal('send'),
            Type.Literal('status'),
          ])),
          name: Type.Optional(Type.String({ description: 'Stable child name for background operations. Names must start with a letter and use letters, digits, _ or -.' })),
          task: Type.Optional(Type.String({ description: 'The complete task for run or spawn.' })),
          message: Type.Optional(Type.String({ description: 'Message for spawn or send.' })),
          instructions: Type.Optional(Type.String({ description: 'Optional role-specific instructions.' })),
          model: Type.Optional(Type.String({
            description: 'Optional provider/modelId override for this child. It must exist in Studio settings.',
          })),
          thinkingLevel: Type.Optional(Type.String({
            description: 'Optional thinking level: off, minimal, low, medium, high, xhigh, or max.',
          })),
          cwd: Type.Optional(Type.String({
            description: 'Optional existing subdirectory inside the parent workspace.',
          })),
          mode: Type.Optional(Type.Union([
            Type.Literal('foreground'),
            Type.Literal('background'),
          ])),
          followUp: Type.Optional(Type.Boolean({
            description: 'For send: queue after the child current answer (default true); false steers at the next step.',
          })),
        }),
        replay: 'safe',
        async execute(args, api, context) {
          throwIfAborted(context);
          const parentConversationId = Number(api.conversationId);
          if (!Number.isSafeInteger(parentConversationId) || parentConversationId <= 0) {
            throw new Error('子 Agent 只能在持久会话中运行');
          }
          const action = args.action || 'run';
          const now = api.now();

          if (action === 'status') {
            const state = await api.snapshot(protocol.Subagents, parentConversationId, context)
              || emptyRegistry();
            const lines = [];
            for (const agent of Object.values(state.agents)) {
              const live = await api.snapshot(durable.LiveDoc, agent.conversationId, context);
              const pending = Object.values(state.supervisorRequests)
                .filter((request) => (
                  request?.childConversationId === agent.conversationId
                  && request.status === 'pending'
                )).length;
              lines.push(
                `${agent.name}: ${live?.run ? 'running' : agent.lastStatus || 'idle'}`
                + ` (${agent.mode || 'background'}, conversation ${agent.conversationId}`
                + `${pending ? `, ${pending} supervisor pending` : ''})`,
              );
            }
            return {
              output: [{ type: 'text', text: lines.join('\n') || 'No subagents.' }],
              details: { agents: Object.values(state.agents) },
            };
          }

          if (action === 'send') {
            const name = normalizeSubagentName(args.name);
            const state = await api.snapshot(protocol.Subagents, parentConversationId, context)
              || emptyRegistry();
            const agent = registryAgent(state, name);
            if (!agent) throw new Error(`没有名为 ${name} 的子 Agent`);
            if (agent.mode !== 'background') {
              throw new Error(`${name} 是前台子 Agent，不能继续发送消息`);
            }
            const message = String(args.message || args.task || '').trim();
            if (!message) throw new Error('send 需要 message');
            if (message.length > MAX_SUBAGENT_TEXT_LENGTH) {
              throw new Error(`子 Agent 消息不能超过 ${MAX_SUBAGENT_TEXT_LENGTH} 个字符`);
            }
            const defaults = normalizeSubagentConfig(
              getSubagentConfig('user'),
              getSubagentConfig('project', settingsWorkspace(await api.agent(context))),
            );
            await api.commit((tx) => createReporter({
              tx,
              durable,
              parentConversationId,
              requestKey: `tool:${api.taskId}`,
              name,
              conversationId: agent.conversationId,
              message,
              followUp: args.followUp !== false,
              now,
              maximum: defaults.maxConcurrent,
            }), context);
            await api.details({
              agents: [{ name, conversationId: String(agent.conversationId) }],
            }, context);
            return {
              output: [{ type: 'text', text: `已向 ${name} 发送消息；结果完成后会自动回传。` }],
              details: { name, conversationId: String(agent.conversationId) },
            };
          }

          const settingsBase = await resolveChildSettings(
            args,
            api,
            context,
            childSupervisorTool,
            piAi,
          );
          const settings = { ...settingsBase, createdAt: now };
          const explicitBackground = action === 'spawn' || args.mode === 'background';
          const background = explicitBackground
            || (!args.mode && settings.defaults.defaultMode === 'background');
          if (background && !settings.defaults.backgroundEnabled) {
            throw new Error('后台子 Agent 已在 Studio 设置中关闭');
          }
          const taskText = String(args.task || args.message || '').trim();
          if (!taskText) throw new Error(`${action} 需要 task 或 message`);
          if (taskText.length > MAX_SUBAGENT_TEXT_LENGTH) {
            throw new Error(`子 Agent 任务不能超过 ${MAX_SUBAGENT_TEXT_LENGTH} 个字符`);
          }
          const instructions = String(args.instructions || '').trim();
          if (instructions.length > MAX_SUBAGENT_INSTRUCTIONS_LENGTH) {
            throw new Error(`子 Agent 附加指令不能超过 ${MAX_SUBAGENT_INSTRUCTIONS_LENGTH} 个字符`);
          }
          const requestedName = background
            ? normalizeSubagentName(args.name, `agent-${api.taskId}`)
            : undefined;

          if (background) {
            const created = await api.commit(async (tx) => {
              const state = await tx.doc(protocol.Subagents, parentConversationId);
              const previous = registryReporter(state, `tool:${api.taskId}`);
              if (previous) {
                return {
                  name: previous.name,
                  conversationId: registryAgent(state, previous.name).conversationId,
                  taskId: previous.taskId,
                  replayed: true,
                };
              }
              if (Object.keys(state.agents).length >= settings.defaults.maxSpawns) {
                throw new Error(`当前会话最多创建 ${settings.defaults.maxSpawns} 个子 Agent`);
              }
              if (registryAgent(state, requestedName)) {
                throw new Error(`子 Agent 名称已存在：${requestedName}；请使用 action=send`);
              }
              const anchorTaskId = await tx.createTask(
                protocol.Anchor,
                null,
                backgroundOptions(),
              );
              const child = await tx.createConversation({
                ownership: { kind: 'task', taskId: anchorTaskId },
              });
              await configureChildConversation({
                tx,
                durable,
                childId: child.id,
                parentConversationId,
                name: requestedName,
                anchorTaskId,
                ownerTaskId: 0,
                mode: 'background',
                settings,
                instructions: [
                  instructions,
                  childInstructions(
                    requestedName,
                    parentConversationId,
                    settings.defaults.supervisorEnabled,
                  ),
                ].filter(Boolean).join('\n\n'),
                parentExtension,
                childChannelExtension: channel,
              });
              const reporter = await createReporter({
                tx,
                durable,
                parentConversationId,
                requestKey: `tool:${api.taskId}`,
                name: requestedName,
                conversationId: child.id,
                message: taskText,
                followUp: false,
                now,
                maximum: settings.defaults.maxConcurrent,
              });
              return {
                name: requestedName,
                conversationId: child.id,
                taskId: reporter.taskId,
                replayed: false,
              };
            }, context);
            await api.details({
              name: created.name,
              conversationId: String(created.conversationId),
              reporterTaskId: String(created.taskId),
            }, context);
            return {
              output: [{
                type: 'text',
                text: created.replayed
                  ? `${created.name} 的本次后台请求已经在运行。`
                  : `已在后台启动 ${created.name}；主 Agent 可以继续工作，结果会作为 follow-up 回传。`,
              }],
              details: {
                name: created.name,
                conversationId: String(created.conversationId),
                reporterTaskId: String(created.taskId),
              },
            };
          }

          const childId = await api.commit(async (tx) => {
            const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
            const id = existing?.id || (await tx.createConversation({
              ownership: { kind: 'task', taskId: api.taskId },
            })).id;
            const state = await tx.doc(protocol.Subagents, parentConversationId);
            const existingRegistryChild = Object.values(state.agents)
              .find((agent) => agent.ownerTaskId === api.taskId);
            const name = existingRegistryChild?.name
              || normalizeSubagentName(args.name, `foreground-${api.taskId}`);
            if (registryAgent(state, name) && !existingRegistryChild) {
              throw new Error(`子 Agent 名称已存在：${name}`);
            }
            if (!existingRegistryChild && Object.keys(state.agents).length >= settings.defaults.maxSpawns) {
              throw new Error(`当前会话最多创建 ${settings.defaults.maxSpawns} 个子 Agent`);
            }
            await configureChildConversation({
              tx,
              durable,
              childId: id,
              parentConversationId,
              name,
              anchorTaskId: 0,
              ownerTaskId: api.taskId,
              mode: 'foreground',
              settings,
              instructions: [
                instructions,
                childInstructions(name, parentConversationId, false),
              ].filter(Boolean).join('\n\n'),
              parentExtension,
              childChannelExtension: channel,
            });
            return { id, name };
          }, context);
          throwIfAborted(context);
          await api.details({
            name: childId.name,
            conversationId: String(childId.id),
          }, context);
          const conversation = await api.conversation(childId.id, context);
          if (!conversation) throw new Error('子 Agent 会话创建失败');
          const submission = await conversation.submit({
            type: 'input',
            content: taskText,
            requestId: `subagent:${api.taskId}`,
          }, context);
          let settled;
          let text = '';
          let lastStatus = 'failed';
          let lastError = '子 Agent 执行失败';
          try {
            settled = await submission.wait(context);
            if (settled.status === 'done' && settled.type === 'input' && settled.answer !== undefined) {
              const answer = await api.commit(
                (tx) => tx.entry(settled.answer),
                context,
              );
              text = protocol.textOfEntry(answer);
            }
            lastStatus = context?.abortSignal?.aborted
              ? 'stopped'
              : settled.status === 'done'
                ? 'completed'
                : settled.reason === 'aborted'
                  ? 'stopped'
                  : 'failed';
            lastError = lastStatus === 'failed'
              ? String(settled.reason || settled.status || '子 Agent 执行失败')
              : undefined;
          } catch (error) {
            lastStatus = context?.abortSignal?.aborted ? 'stopped' : 'failed';
            lastError = error instanceof Error ? error.message : String(error);
            throw error;
          } finally {
            try {
              await writeSubagentStatus({
                api,
                protocol,
                parentConversationId,
                name: childId.name,
                status: lastStatus,
                error: lastError,
                context,
              });
            } catch (error) {
              // The owning Durable task remains the authoritative fallback in
              // the read-only child projection.
              console.warn('Unable to persist subagent terminal status:', error);
            }
          }
          throwIfAborted(context);
          return {
            output: [{
              type: 'text',
              text: settled.status === 'done'
                ? text || '子 Agent 已完成，但没有返回文本。'
                : `子 Agent 未能回答：${settled.reason || settled.status}`,
            }],
            details: {
              name: childId.name,
              conversationId: String(childId.id),
              submissionId: String(submission.id),
              status: settled.status,
            },
          };
        },
      }),
      defineTool({
        name: 'subagent_stop',
        description: 'Stop the current run of one named background child. The child conversation remains available for later messages. This operation is deliberately not replayed after a crash.',
        parameters: Type.Object({
          name: Type.String({ description: 'The background child name.' }),
        }),
        replay: 'unsafe',
        async execute(args, api, context) {
          const parentConversationId = Number(api.conversationId);
          const name = normalizeSubagentName(args.name);
          const state = await api.snapshot(protocol.Subagents, parentConversationId, context)
            || emptyRegistry();
          const agent = registryAgent(state, name);
          if (!agent) throw new Error(`没有名为 ${name} 的子 Agent`);
          if (agent.mode !== 'background') {
            throw new Error(`${name} 不是后台子 Agent`);
          }
          const conversation = await api.conversation(agent.conversationId, context);
          if (conversation) await conversation.abort(context, { background: true });
          await api.commit(async (tx) => {
            const registry = await tx.doc(protocol.Subagents, parentConversationId);
            const current = registryAgent(registry, name);
            if (current) {
              current.lastStatus = 'stopped';
              current.updatedAt = api.now();
            }
          }, context);
          return {
            output: [{ type: 'text', text: `已停止 ${name} 的当前运行。` }],
            details: { name, conversationId: String(agent.conversationId) },
          };
        },
      }),
      defineTool({
        name: 'bg_wait',
        description: 'Wait for a reporter of one background child or a specific reporter run. A timeout or cancellation ends only this wait; it never stops the child.',
        parameters: Type.Object({
          name: Type.Optional(Type.String({ description: 'Background child name. The newest reporter is selected.' })),
          runId: Type.Optional(Type.String({ description: 'Specific reporter task ID returned by subagent.' })),
          timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 600000 })),
        }),
        replay: 'safe',
        async execute(args, api, context) {
          const parentConversationId = Number(api.conversationId);
          const state = await api.snapshot(protocol.Subagents, parentConversationId, context)
            || emptyRegistry();
          const reporters = Object.values(state.reporters);
          let reporter;
          if (args.runId) {
            const id = Number(args.runId);
            reporter = reporters.find((item) => Number(item.taskId) === id);
            if (!reporter) throw new Error('指定的后台 reporter 不属于当前会话');
          } else {
            const name = normalizeSubagentName(args.name);
            reporter = reporters
              .filter((item) => item.name === name)
              .sort((left, right) => Number(right.taskId) - Number(left.taskId))[0];
            if (!reporter) throw new Error(`${name} 没有可等待的后台运行`);
          }
          const defaults = normalizeSubagentConfig(
            getSubagentConfig('user'),
            getSubagentConfig('project', settingsWorkspace(await api.agent(context))),
          );
          const timeoutMs = Math.min(
            600_000,
            Math.max(1_000, Number(args.timeoutMs) || defaults.waitTimeoutMs),
          );
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(new Error('bg_wait timeout')), timeoutMs);
          timer.unref?.();
          const waitContext = chordContext?.withAbortSignal
            ? chordContext.withAbortSignal(timeout.signal, context)
            : context;
          let timedOut = false;
          try {
            await api.waitForTask(reporter.taskId, waitContext);
          } catch (error) {
            if (context?.abortSignal?.aborted) throw error;
            if (!timeout.signal.aborted) throw error;
            timedOut = true;
          } finally {
            clearTimeout(timer);
          }
          const task = await api.getTask(reporter.taskId, context);
          return {
            output: [{
              type: 'text',
              text: timedOut
                ? `${reporter.name} 仍在运行；本次等待在 ${timeoutMs}ms 后结束，child 未被停止。`
                : `${reporter.name} 的这次运行已结束（${task?.state?.status || 'terminal'}）。`,
            }],
            details: {
              name: reporter.name,
              reporterTaskId: String(reporter.taskId),
              timedOut,
              terminal: Boolean(task && task.state?.status === 'terminal'),
            },
          };
        },
      }),
      defineTool({
        name: 'subagent_supervisor',
        description: 'Review pending questions from child Agents and reply to one. Replies are queued as a child follow-up and the child answer is reported back.',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('pending'),
            Type.Literal('reply'),
          ]),
          replyTo: Type.Optional(Type.String({ description: 'Supervisor request ID returned by contact_supervisor.' })),
          message: Type.Optional(Type.String({ description: 'Answer to the child request.' })),
        }),
        replay: 'safe',
        async execute(args, api, context) {
          const parentConversationId = Number(api.conversationId);
          const state = await api.snapshot(protocol.Subagents, parentConversationId, context)
            || emptyRegistry();
          if (args.action === 'pending') {
            const pending = Object.values(state.supervisorRequests)
              .filter((request) => request.status === 'pending')
              .sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
            const text = pending.length
              ? pending.map((request) => (
                `${request.requestId} · ${request.childName}: ${request.question}`
              )).join('\n')
              : '没有待回复的子 Agent 监督请求。';
            return {
              output: [{ type: 'text', text }],
              details: { requests: pending },
            };
          }
          const replyTo = String(args.replyTo || '').trim();
          const message = String(args.message || '').trim();
          if (!replyTo || !message) throw new Error('reply 需要 replyTo 和 message');
          if (message.length > MAX_SUBAGENT_SUPERVISOR_LENGTH) {
            throw new Error(`监督回复不能超过 ${MAX_SUBAGENT_SUPERVISOR_LENGTH} 个字符`);
          }
          const request = Object.hasOwn(state.supervisorRequests, replyTo)
            ? state.supervisorRequests[replyTo]
            : undefined;
          if (!request) throw new Error('监督请求不存在或不属于当前会话');
          if (request.status === 'replied' && request.reply !== message) {
            throw new Error('这个监督请求已经用其他内容回复');
          }
          const agent = registryAgent(state, request.childName);
          if (!agent || agent.conversationId !== request.childConversationId) {
            throw new Error('监督请求对应的子 Agent 已失效');
          }
          const now = api.now();
          const defaults = normalizeSubagentConfig(
            getSubagentConfig('user'),
            getSubagentConfig('project', settingsWorkspace(await api.agent(context))),
          );
          const reporter = await api.commit(async (tx) => {
            const registry = await tx.doc(protocol.Subagents, parentConversationId);
            const current = Object.hasOwn(registry.supervisorRequests, replyTo)
              ? registry.supervisorRequests[replyTo]
              : undefined;
            if (!current) throw new Error('监督请求已不存在');
            current.status = 'replied';
            current.reply = message;
            current.updatedAt = now;
            return createReporter({
              tx,
              durable,
              parentConversationId,
              requestKey: `supervisor-reply:${replyTo}`,
              name: current.childName,
              conversationId: current.childConversationId,
              message: [
                `[supervisor reply to ${current.childName}]`,
                current.reply,
                'Continue the task using this decision. Ask again only if a different decision is required.',
              ].join('\n'),
              followUp: true,
              now,
              maximum: defaults.maxConcurrent,
            });
          }, context);
          return {
            output: [{
              type: 'text',
              text: `已回复 ${request.childName}；回复会进入 child 的 follow-up，结果完成后再回传。`,
            }],
            details: {
              requestId: replyTo,
              reporterTaskId: String(reporter.taskId),
              conversationId: String(request.childConversationId),
            },
          };
        },
      }),
    ],
  });
  return { parentExtension, channel };
}

function createStudioBuiltins({
  durable,
  piAi,
  codingTools,
  toolSearch,
  chordContext,
}) {
  if (!codingTools || !toolSearch) {
    throw new Error('Studio 内置扩展缺少 Durable CodingTools 或 tool_search 实例');
  }
  const subagents = createSubagentExtension(durable, piAi, chordContext);
  return new Map([
    ['builtin:durable-coding-tools', codingTools],
    ['builtin:studio-filesystem-tools', createFilesystemTools(durable, piAi)],
    ['builtin:studio-todo', createStudioTodoExtension(durable, piAi)],
    ['builtin:studio-long-task', createLongTaskExtension(durable, piAi)],
    ['builtin:studio-harness', createStudioHarnessExtension(durable)],
    ['builtin:studio-tool-search', toolSearch],
    ['builtin:studio-skills', createSkillsExtension(durable)],
    ['builtin:studio-permissions', createPermissionsExtension(durable)],
    ['builtin:studio-subagents', subagents.parentExtension],
    ['builtin:studio-subagent-channel', subagents.channel],
    ['builtin:studio-metrics', durable.defineExtension({ name: 'studio-metrics' })],
  ]);
}

module.exports = {
  BUILTIN_MANIFESTS,
  createFilesystemTools,
  createStudioBuiltins,
  resolveWorkspacePath,
  walkFiles,
};
