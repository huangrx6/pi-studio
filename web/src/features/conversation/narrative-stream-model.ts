import type { ChatMessage, RequestTrace, ToolCallBlock, TurnDiff } from '../../types/chat-types.ts';
import {
  buildExecutionPhases,
  type ConversationImage,
  type ExecutionPhase,
  type PhaseCategory,
} from './execution-flow-model.ts';
import { normalizePathKey, toolResultDiff, writtenLineCount } from './file-changes.ts';
import { activityKind, type ActivityEntry, type BuiltTurnContent } from './turn-content.ts';

type TurnSegment = BuiltTurnContent['segments'][number];

export type NarrativeBlock =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'images'; key: string; images: ConversationImage[] }
  | { kind: 'work'; key: string; entries: ActivityEntry[]; toolImages: Map<string, ConversationImage[]> };

export type StepIconKind =
  | 'thinking'
  | 'read'
  | 'search'
  | 'edit'
  | 'command'
  | 'web'
  | 'verify'
  | 'agent'
  | 'other';

export type NarrativeStepItem = {
  key: string;
  entry: ActivityEntry;
  icon: StepIconKind;
  /** Leading action phrase, e.g. "已读取" / "已创建" / "已在 render.py 中搜索" */
  prefix: string;
  /** Underlined clickable file basename when applicable */
  fileLabel?: string;
  filePath?: string;
  /** Secondary inline detail after fileLabel, e.g. `“preview|sandbox”` or command snippet */
  detail?: string;
  diff?: { added: number; removed: number };
  images: ConversationImage[];
  status: 'running' | 'done' | 'error' | 'incomplete';
  liveThoughtExcerpt?: string;
};

export type NarrativePhase = ExecutionPhase & {
  icon: StepIconKind;
  headline: string;
  diff?: { added: number; removed: number };
  imageCount: number;
  steps: NarrativeStepItem[];
};

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function compactRelativeFileLabel(filePath: string, cwd?: string): string {
  const normalized = normalizePathKey(filePath);
  if (!normalized) return '';
  let display = normalized;
  if (cwd) {
    const cleanCwd = normalizePathKey(cwd).replace(/\/+$/, '');
    if (cleanCwd && display.startsWith(`${cleanCwd}/`)) {
      display = display.slice(cleanCwd.length + 1);
    }
  }
  if (display.startsWith('/')) {
    const parts = display.split('/').filter(Boolean);
    display = parts.length <= 2 ? parts.join('/') : parts.slice(-2).join('/');
  }
  if (display.length <= 44) return display;
  const parts = display.split('/').filter(Boolean);
  if (parts.length >= 2) {
    const tail = parts.slice(-2).join('/');
    if (tail.length <= 44) return tail;
  }
  return basename(display);
}

/** Collect all concrete file paths touched by tools or Git snapshots in a turn. */
export function collectTurnFilePaths(
  messages: readonly ChatMessage[],
  gitDiff?: TurnDiff,
): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  const add = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const key = normalizePathKey(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    output.push(trimmed);
  };

  for (const file of gitDiff?.files ?? []) add(file.path);
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      add(block.arguments?.path);
      add(block.arguments?.file_path);
    }
  }
  return output;
}

/**
 * Resolve a relative Markdown path token (e.g. `docs/PLAN.md`) against concrete paths
 * actually touched in this turn so links in thinking/prose open the exact same file & tab.
 */
export function resolveTurnFilePath(
  token: string,
  turnPaths: readonly string[],
  cwd?: string,
): string | undefined {
  const trimmed = token.trim();
  if (!trimmed || turnPaths.length === 0) return undefined;
  if (/^(?:\/|~\/|[a-zA-Z]:[\\/]|\\\\|file:)/i.test(trimmed)) return undefined;

  const clean = normalizePathKey(trimmed).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean) return undefined;

  const normalizedPaths = turnPaths.map((original) => ({
    original,
    key: normalizePathKey(original).replace(/\/+$/, ''),
  }));

  // 1. Exact workspace-root match first when cwd is present.
  if (cwd) {
    const cleanCwd = normalizePathKey(cwd).replace(/\/+$/, '');
    const exactKey = `${cleanCwd}/${clean}`;
    const exact = normalizedPaths.find((item) => item.key === exactKey);
    if (exact) return exact.original;
  }

  // 2. Boundary-aligned suffix match (e.g. `docs/PLAN.md` -> `.../dsh-workbench/docs/PLAN.md`).
  const matches = normalizedPaths.filter(
    (item) => item.key === clean || item.key.endsWith(`/${clean}`),
  );
  if (matches.length === 1) return matches[0].original;
  return undefined;
}

function toolFilePath(call: ToolCallBlock): string {
  const path = call.arguments?.path ?? call.arguments?.file_path;
  return typeof path === 'string' ? path.trim() : '';
}

function compactText(value: unknown, limit = 56): string {
  if (typeof value !== 'string') return '';
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function stripMarkdownNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^[\s>#*\-\d.、]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractThoughtHeadline(raw: string): string {
  const cleaned = stripMarkdownNoise(raw);
  if (!cleaned) return '';
  const clauses = cleaned
    .split(/(?:[。！？\n]|(?:\.\s+))/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
  const lead = clauses[0] || '';
  if (lead.length < 8) return '';
  return lead.length > 40 ? `${lead.slice(0, 39).trimEnd()}…` : lead;
}

export function extractLiveThoughtExcerpt(raw: string, limit = 180): string {
  const cleaned = stripMarkdownNoise(raw);
  if (!cleaned) return '';
  if (cleaned.length <= limit) return cleaned;
  const tail = cleaned.slice(-limit);
  const sentenceBreak = tail.search(/[。！？；，,.]\s*/);
  const trimmed = sentenceBreak >= 0 && sentenceBreak < 52
    ? tail.slice(sentenceBreak + 1).trimStart()
    : tail.replace(/^\S*\s+/, '');
  return `…${trimmed || tail}`;
}

function categoryToIcon(category: PhaseCategory): StepIconKind {
  if (category === 'plan') return 'thinking';
  if (category === 'explore') return 'search';
  if (category === 'edit') return 'edit';
  if (category === 'command') return 'command';
  if (category === 'web') return 'web';
  if (category === 'verify') return 'verify';
  if (category === 'agent') return 'agent';
  return 'other';
}

function buildStepItem(
  entry: ActivityEntry,
  results: Map<string, ChatMessage>,
  toolImages?: ReadonlyMap<string, ConversationImage[]>,
  cwd?: string,
): NarrativeStepItem {
  if (entry.kind === 'thinking') {
    const hasText = !entry.block.redacted && Boolean(entry.block.thinking.trim());
    const headline = hasText ? extractThoughtHeadline(entry.block.thinking) : '';
    return {
      key: entry.key,
      entry,
      icon: 'thinking',
      prefix: entry.live ? '正在思考' : '思考过程',
      detail: headline || undefined,
      images: [],
      status: entry.live ? 'running' : 'done',
      liveThoughtExcerpt: entry.live && hasText ? extractLiveThoughtExcerpt(entry.block.thinking) : undefined,
    };
  }

  const { call } = entry;
  const result = results.get(call.id);
  const running = entry.live && !result;
  const status: NarrativeStepItem['status'] = running
    ? 'running'
    : !result
      ? 'incomplete'
      : result.isError
        ? 'error'
        : 'done';
  const kind = activityKind(entry);
  const args = call.arguments || {};
  const images = toolImages?.get(call.id) ?? [];
  const filePath = toolFilePath(call);
  const fileLabel = filePath ? compactRelativeFileLabel(filePath, cwd) : undefined;

  if (call.name === 'read') {
    return {
      key: entry.key,
      entry,
      icon: 'read',
      prefix: running ? '正在读取' : '已读取',
      fileLabel,
      filePath: filePath || undefined,
      detail: fileLabel ? undefined : '文件',
      images,
      status,
    };
  }

  if (call.name === 'grep' || call.name === 'find' || call.name === 'ls') {
    const pattern = compactText(args.pattern || args.query || args.glob, 34);
    if (call.name === 'grep' && pattern) {
      return {
        key: entry.key,
        entry,
        icon: 'search',
        prefix: running ? '正在搜索' : fileLabel ? '已在' : '已搜索',
        fileLabel,
        filePath: filePath || undefined,
        detail: fileLabel ? `中搜索“${pattern}”` : `“${pattern}”`,
        images,
        status,
      };
    }
    return {
      key: entry.key,
      entry,
      icon: 'search',
      prefix: running ? '正在查找' : call.name === 'ls' ? '已查看目录' : '已查找',
      fileLabel,
      filePath: filePath || undefined,
      detail: pattern ? `“${pattern}”` : undefined,
      images,
      status,
    };
  }

  if (kind === 'write' || kind === 'edit') {
    let diff: { added: number; removed: number } | undefined;
    if (result && !result.isError) {
      const parsed = toolResultDiff(result);
      if (parsed) {
        diff = { added: parsed.added, removed: parsed.removed };
      } else if (call.name === 'write' && typeof args.content === 'string') {
        const added = writtenLineCount(args.content);
        if (added > 0) diff = { added, removed: 0 };
      }
    }
    const verb = kind === 'write'
      ? (running ? '正在创建' : '已创建')
      : (running ? '正在编辑' : '已编辑');
    return {
      key: entry.key,
      entry,
      icon: 'edit',
      prefix: verb,
      fileLabel,
      filePath: filePath || undefined,
      diff,
      images,
      status,
    };
  }

  if (kind === 'command') {
    const cmd = compactText(args.command, 72) || '执行命令';
    return {
      key: entry.key,
      entry,
      icon: 'command',
      prefix: '',
      detail: cmd,
      images,
      status,
    };
  }

  if (call.name === 'browser_type') {
    return {
      key: entry.key,
      entry,
      icon: 'web',
      prefix: running ? '正在填写网页表单' : '已填写网页表单',
      images,
      status,
    };
  }

  if (images.length > 0 || call.name === 'browser_screenshot' || call.name.endsWith('take_screenshot')) {
    return {
      key: entry.key,
      entry,
      icon: 'verify',
      prefix: running ? '正在截取页面画面' : '已截取页面画面',
      detail: images.length > 1 ? `${images.length} 张` : undefined,
      images,
      status,
    };
  }

  if (kind === 'search' || kind === 'fetch' || kind === 'browser') {
    let target = compactText(args.query || args.url, 44);
    if (typeof args.url === 'string' && args.url.trim()) {
      try {
        const parsed = new URL(args.url);
        target = parsed.hostname || target;
      } catch {
        // Keep compact url text
      }
    }
    const verb = kind === 'search'
      ? (running ? '正在搜索网页' : '已搜索网页')
      : kind === 'fetch'
        ? (running ? '正在读取网页' : '已读取网页')
        : (running ? '正在操作页面' : '已操作页面');
    return {
      key: entry.key,
      entry,
      icon: 'web',
      prefix: verb,
      detail: target || undefined,
      images,
      status,
    };
  }

  if (kind === 'agent') {
    const name = compactText(args.name || args.role || args.task, 32) || '子任务';
    return {
      key: entry.key,
      entry,
      icon: 'agent',
      prefix: name,
      detail: running ? '进行中' : status === 'error' ? '执行失败' : '已完成',
      images,
      status,
    };
  }

  const baseName = call.name.split('__').at(-1) || call.name;
  return {
    key: entry.key,
    entry,
    icon: 'other',
    prefix: running ? `正在调用 ${baseName}` : `已调用 ${baseName}`,
    fileLabel,
    filePath: filePath || undefined,
    images,
    status,
  };
}

function isTrivialGluePhase(phase: ExecutionPhase): boolean {
  if (phase.images.length > 0 || phase.category === 'edit' || phase.category === 'verify') return false;
  if (phase.toolCount > 1) return false;
  const tool = phase.entries.find((entry): entry is Extract<ActivityEntry, { kind: 'tool' }> => entry.kind === 'tool');
  if (!tool) return false;
  return /^(?:tool_search|todo|ls)$/.test(tool.call.name);
}

function mergeTwoPhases(base: ExecutionPhase, next: ExecutionPhase, category: PhaseCategory): ExecutionPhase {
  const entries = [...base.entries, ...next.entries];
  const images = [...base.images, ...next.images];
  const errorCount = base.errorCount + next.errorCount;
  const incompleteCount = base.incompleteCount + next.incompleteCount;
  const toolCount = base.toolCount + next.toolCount;
  const thoughtCount = base.thoughtCount + next.thoughtCount;
  const status = next.status === 'running' || base.status === 'running'
    ? 'running'
    : errorCount > 0
      ? 'error'
      : incompleteCount > 0
        ? 'incomplete'
        : 'done';
  return {
    ...base,
    category,
    entries,
    images,
    errorCount,
    incompleteCount,
    toolCount,
    thoughtCount,
    status,
    activeLabel: next.activeLabel ?? base.activeLabel,
  };
}

/**
 * Consolidate raw micro-phases into at most ~5 calm editorial top-level groups:
 * 1) Absorb trivial glue calls (tool_search / todo).
 * 2) Merge visual QA loops (`verify -> brief command/explore -> verify`) into one `verify` group.
 * 3) Merge adjacent read/web/command research bursts so completed work never explodes into 20 rows.
 */
function consolidateExecutionPhases(raw: readonly ExecutionPhase[]): ExecutionPhase[] {
  if (raw.length <= 1) return [...raw];

  const withoutGlue: ExecutionPhase[] = [];
  for (const phase of raw) {
    const prev = withoutGlue.at(-1);
    if (prev && isTrivialGluePhase(phase) && phase.status !== 'running') {
      withoutGlue[withoutGlue.length - 1] = mergeTwoPhases(prev, phase, prev.category);
    } else {
      withoutGlue.push(phase);
    }
  }

  const mergedVerify: ExecutionPhase[] = [];
  let i = 0;
  while (i < withoutGlue.length) {
    let current = withoutGlue[i];
    if (current.category === 'verify') {
      while (i + 1 < withoutGlue.length) {
        const next = withoutGlue[i + 1];
        if (next.category === 'verify') {
          current = mergeTwoPhases(current, next, 'verify');
          i += 1;
          continue;
        }
        const afterNext = withoutGlue[i + 2];
        if (
          afterNext?.category === 'verify'
          && (next.category === 'command' || next.category === 'explore' || next.category === 'other')
          && next.toolCount <= 6
        ) {
          current = mergeTwoPhases(mergeTwoPhases(current, next, 'verify'), afterNext, 'verify');
          i += 2;
          continue;
        }
        break;
      }
    }
    mergedVerify.push(current);
    i += 1;
  }

  // Merge adjacent non-edit/non-verify research bursts (explore / web / command) when block is long (> 5 groups).
  if (mergedVerify.length <= 5) return mergedVerify;

  const coarse: ExecutionPhase[] = [];
  const isResearch = (cat: PhaseCategory) => cat === 'explore' || cat === 'web' || cat === 'command' || cat === 'plan' || cat === 'other';
  for (const phase of mergedVerify) {
    const prev = coarse.at(-1);
    if (
      prev
      && prev.status !== 'running'
      && phase.status !== 'running'
      && isResearch(prev.category)
      && isResearch(phase.category)
    ) {
      const keptCategory: PhaseCategory = prev.category === 'explore' || phase.category === 'explore'
        ? 'explore'
        : prev.category === 'web' || phase.category === 'web'
          ? 'web'
          : 'command';
      coarse[coarse.length - 1] = mergeTwoPhases(prev, phase, keptCategory);
    } else {
      coarse.push(phase);
    }
  }
  return coarse;
}

function buildPhaseHeadline(
  phase: ExecutionPhase,
  steps: readonly NarrativeStepItem[],
): string {
  const toolSteps = steps.filter((step) => step.entry.kind === 'tool');
  const running = phase.status === 'running';
  const fileNames = [...new Set(toolSteps.map((step) => step.fileLabel).filter((name): name is string => Boolean(name)))];

  if (phase.category === 'plan') {
    return running ? '正在思考' : '已思考';
  }
  if (phase.category === 'explore') {
    if (fileNames.length === 1) return `${running ? '正在读取' : '已读取'} ${fileNames[0]}`;
    if (fileNames.length > 1) return running ? `正在查阅 ${fileNames.length} 个文件` : `已读取 ${fileNames.length} 个文件`;
    return running ? '正在查阅源码与资料' : '已查阅源码与资料';
  }
  if (phase.category === 'edit') {
    if (fileNames.length === 1) return `${running ? '正在修改' : '已修改'} ${fileNames[0]}`;
    if (fileNames.length > 1) return `${running ? '正在修改' : '已修改'} ${fileNames[0]} 等 ${fileNames.length} 个文件`;
    return running ? '正在编写与修改代码' : '已编写与修改代码';
  }
  if (phase.category === 'verify') {
    if (phase.images.length > 0) {
      return running ? `正在验收页面（已截图 ${phase.images.length} 张）` : `页面验证与截图（${phase.images.length} 张）`;
    }
    return running ? '正在验证页面效果' : '已完成页面验证';
  }
  if (phase.category === 'web') {
    return running ? '正在检索网页资料' : '已检索网页资料';
  }
  if (phase.category === 'agent') {
    if (toolSteps.length === 1) {
      const single = toolSteps[0];
      return `${single.prefix} ${single.detail || (running ? '进行中' : '已完成')}`.trim();
    }
    return running ? `正在处理 ${toolSteps.length} 个子任务` : `已完成 ${toolSteps.length} 个子任务`;
  }
  if (phase.category === 'command') {
    return running
      ? '正在执行命令与检查'
      : toolSteps.length === 1 && toolSteps[0].detail
        ? toolSteps[0].detail
        : `已执行 ${toolSteps.length} 条命令`;
  }
  return running ? `正在${phase.title}` : `已完成${phase.title}`;
}

/**
 * Group turn segments in strict chronological order:
 * - Consecutive tool/thinking work + non-generated tool screenshots fuse into one `work` block.
 * - Intermediate assistant text and deliverable generated images stay in exact chronological place.
 */
export function buildNarrativeBlocks(
  segments: readonly TurnSegment[],
): NarrativeBlock[] {
  const generatedImageCalls = new Set<string>();
  for (const segment of segments) {
    if (segment.kind !== 'activity') continue;
    for (const entry of segment.entries) {
      if (entry.kind === 'tool' && activityKind(entry) === 'image') {
        generatedImageCalls.add(entry.call.id);
      }
    }
  }

  const output: NarrativeBlock[] = [];
  for (const segment of segments) {
    const previous = output.at(-1);
    if (segment.kind === 'activity') {
      if (previous?.kind === 'work') {
        previous.entries.push(...segment.entries);
      } else {
        output.push({
          kind: 'work',
          key: segment.key,
          entries: [...segment.entries],
          toolImages: new Map(),
        });
      }
      continue;
    }

    if (segment.kind === 'tool-images') {
      if (generatedImageCalls.has(segment.callId)) {
        output.push({ kind: 'images', key: segment.key, images: segment.images });
      } else if (previous?.kind === 'work') {
        const existing = previous.toolImages.get(segment.callId) ?? [];
        previous.toolImages.set(segment.callId, [...existing, ...segment.images]);
      } else {
        output.push({ kind: 'images', key: segment.key, images: segment.images });
      }
      continue;
    }

    if (segment.kind === 'images') {
      output.push({ kind: 'images', key: segment.key, images: segment.images });
      continue;
    }

    output.push({ kind: 'text', key: segment.key, text: segment.text });
  }

  return output;
}

export function buildNarrativePhases(
  entries: ActivityEntry[],
  results: Map<string, ChatMessage>,
  toolImages?: ReadonlyMap<string, ConversationImage[]>,
  cwd?: string,
): NarrativePhase[] {
  const rawPhases = consolidateExecutionPhases(buildExecutionPhases(entries, results, toolImages));

  return rawPhases.map((phase) => {
    const steps = phase.entries.map((entry) => buildStepItem(entry, results, toolImages, cwd));
    let added = 0;
    let removed = 0;
    for (const step of steps) {
      if (step.diff) {
        added += step.diff.added;
        removed += step.diff.removed;
      }
    }

    const icon: StepIconKind = steps.length === 1
      ? steps[0].icon
      : categoryToIcon(phase.category);

    return {
      ...phase,
      icon,
      headline: buildPhaseHeadline(phase, steps),
      diff: added > 0 || removed > 0 ? { added, removed } : undefined,
      imageCount: phase.images.length,
      steps,
    };
  });
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Compute the actual start & end epoch ms for a single assistant turn. */
export function computeTurnTiming(
  messages: readonly ChatMessage[],
  toolResults: ReadonlyMap<string, ChatMessage>,
  requestTraces: readonly Pick<RequestTrace, 'createdAt'>[] = [],
  startedAt?: number,
): { startMs?: number; endMs?: number } {
  const traceStarts = requestTraces.map((trace) => trace.createdAt).filter(validTimestamp);
  const msgTimes = messages.map((message) => message.timestamp).filter(validTimestamp);
  const resultTimes: number[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      const ts = toolResults.get(block.id)?.timestamp;
      if (validTimestamp(ts)) resultTimes.push(ts);
    }
  }

  const allEnds = [...msgTimes, ...resultTimes, ...traceStarts];
  const endMs = allEnds.length > 0 ? Math.max(...allEnds) : undefined;
  const earliestTrace = traceStarts.length > 0 ? Math.min(...traceStarts) : undefined;
  const firstMsgTime = msgTimes.length > 0 ? Math.min(...msgTimes) : undefined;

  let startMs: number | undefined;
  if (validTimestamp(startedAt) && (!endMs || startedAt <= endMs)) {
    // If the user message sat in queue for >60s before the first provider request, measure from execution start.
    if (earliestTrace !== undefined && earliestTrace - startedAt > 60_000) {
      startMs = earliestTrace;
    } else {
      startMs = earliestTrace !== undefined ? Math.min(startedAt, earliestTrace) : startedAt;
    }
  } else if (earliestTrace !== undefined) {
    startMs = firstMsgTime !== undefined ? Math.min(earliestTrace, firstMsgTime) : earliestTrace;
  } else if (firstMsgTime !== undefined) {
    startMs = firstMsgTime;
  }

  return { startMs, endMs };
}

/** Format turn elapsed duration in natural Chinese (e.g. "用时 18秒", "用时 2分 17秒"). */
export function formatTurnDuration(durationMs?: number): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 500) return '';
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `用时 ${totalSeconds}秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `用时 ${totalMinutes}分 ${seconds}秒` : `用时 ${totalMinutes}分`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `用时 ${hours}小时 ${minutes}分` : `用时 ${hours}小时`;
}
