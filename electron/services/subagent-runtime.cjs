/**
 * pi-subagents runtime projection.
 *
 * `pi-subagents` exposes live child progress on tool-execution events and keeps
 * completed foreground / background runs in the parent transcript. This module
 * converts both shapes into one bounded renderer contract, merges updates by a
 * stable key, and only opens child transcripts that live below the current
 * parent session's pi-subagents session directory.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { piModule } = require('../core/state.cjs');
const { serializeMessage, visibleSessionMessages } = require('../core/serialize.cjs');

const MAX_CHILDREN = 100;
const MAX_TRANSCRIPT_MESSAGES = 500;
const MAX_PREVIEW = 900;
const FINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'paused']);
const STATUS_RANK = {
  pending: 0,
  running: 1,
  paused: 2,
  failed: 3,
  stopped: 3,
  completed: 3,
};

/** sessionId → key → internal child projection. */
const liveChildren = new Map();

function text(value, limit = MAX_PREVIEW) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length > limit ? `${normalized.slice(0, limit).trimEnd()}…` : normalized;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timestampValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const total = finiteNumber(usage.totalTokens) ?? finiteNumber(usage.total);
  if (total !== undefined) return total;
  const values = [
    usage.input,
    usage.output,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheRead,
    usage.cacheWrite,
  ].map(finiteNumber).filter((value) => value !== undefined);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function normalizedStatus(value, fallback = {}) {
  if (fallback.stopped) return 'stopped';
  if (fallback.interrupted) return 'stopped';
  if (fallback.timedOut) return 'failed';
  if (fallback.error) return 'failed';
  const status = typeof value === 'string' ? value.toLowerCase() : '';
  if (status === 'complete') return 'completed';
  if (status === 'detached') return 'running';
  if (Object.hasOwn(STATUS_RANK, status)) return status;
  if (fallback.exitCode === 0) return 'completed';
  if (typeof fallback.exitCode === 'number') return 'failed';
  return 'pending';
}

function mergeStatus(previous, next) {
  if (!previous) return next;
  if (!next) return previous;
  const previousRank = STATUS_RANK[previous] ?? 0;
  const nextRank = STATUS_RANK[next] ?? 0;
  // Once a run settles, a late event cannot turn it into a different terminal
  // state (for example completed → failed) or back into a running spinner.
  if (FINAL_STATUSES.has(previous)) return previous;
  return nextRank >= previousRank ? next : previous;
}

function stableFallbackKey(agent, task, index) {
  const digest = crypto.createHash('sha1')
    .update(`${agent}\0${task}\0${index}`)
    .digest('hex')
    .slice(0, 12);
  return `local:${digest}`;
}

function stableRunId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value) ? value : '';
}

function childIdentity({ runId, toolCallId, agent, task, index }) {
  const run = stableRunId(runId)
    || (typeof toolCallId === 'string' && toolCallId ? `tool-${toolCallId}` : '')
    || stableFallbackKey(agent, task, index);
  return `${run}:${index}`;
}

function normalizeSource(value, fallback = 'foreground') {
  return value === 'async' || value === 'background' ? 'background' : fallback;
}

function normalizeContext(value, fallback) {
  return value === 'fresh' || value === 'fork' ? value : fallback;
}

function currentToolText(progress) {
  if (!progress || typeof progress !== 'object') return undefined;
  const name = text(progress.currentTool, 80);
  if (!name) return undefined;
  const detail = text(progress.currentPath || progress.currentToolArgs, 120);
  return detail && detail !== name ? `${name} · ${detail}` : name;
}

function previewOf(result, progress) {
  return text(
    result?.finalOutput
      || result?.output
      || result?.error
      || (Array.isArray(progress?.recentOutput) ? progress.recentOutput.slice(-4).join('\n') : '')
      || result?.preview
      || '',
  );
}

function normalizeResultRecord(result, details, options = {}) {
  const progress = result?.progress && typeof result.progress === 'object'
    ? result.progress
    : undefined;
  const index = Number.isInteger(result?.index)
    ? result.index
    : Number.isInteger(progress?.index)
      ? progress.index
      : Number.isInteger(options.index)
        ? options.index
        : 0;
  const agent = text(result?.agent || progress?.agent || options.agent || 'agent', 100);
  const task = text(result?.task || progress?.task || options.task || '未提供任务说明', 2_000);
  const runId = text(result?.runId || details?.runId || options.runId, 240);
  const toolCallId = text(details?.toolCallId || options.toolCallId, 240);
  const error = text(result?.error || progress?.error || '', 1_200) || undefined;
  const status = normalizedStatus(progress?.status || result?.status || options.status, {
    stopped: Boolean(result?.stopped || options.stopped),
    interrupted: Boolean(result?.interrupted || options.interrupted),
    timedOut: Boolean(result?.timedOut || options.timedOut),
    error,
    exitCode: result?.exitCode,
  });
  const durationMs = finiteNumber(progress?.durationMs)
    ?? finiteNumber(result?.durationMs)
    ?? finiteNumber(options.durationMs);
  const turns = finiteNumber(progress?.turnCount);
  const previewPriority = result?.finalOutput || result?.output || result?.error
    ? 2
    : Array.isArray(progress?.recentOutput) && progress.recentOutput.length
      ? 0
      : 1;
  return {
    public: {
      key: childIdentity({ runId, toolCallId, agent, task, index }),
      runId,
      index,
      agent,
      task,
      status,
      source: normalizeSource(options.source || (details?.background ? 'background' : 'foreground')),
      context: normalizeContext(result?.context || (details?.context === 'mixed' ? undefined : details?.context), options.context),
      model: text(progress?.model || result?.model || result?.requestedModel || options.model, 240),
      thinking: text(
        progress?.thinking === false || result?.thinking === false
          ? 'off'
          : progress?.thinking || result?.thinking || options.thinking,
        40,
      ),
      cwd: text(options.cwd || '', 2_048),
      startedAt: timestampValue(result?.startedAt || options.startedAt),
      updatedAt: timestampValue(options.updatedAt || progress?.lastActivityAt) || Date.now(),
      durationMs,
      tokens: finiteNumber(progress?.tokens) ?? usageTokens(result?.usage),
      toolCount: finiteNumber(progress?.toolCount),
      turnCount: turns,
      currentTool: currentToolText(progress),
      preview: previewOf(result, progress),
      error,
      hasTranscript: false,
    },
    sessionFile: typeof result?.sessionFile === 'string' ? result.sessionFile : '',
    transcriptPath: typeof result?.transcriptPath === 'string' ? result.transcriptPath : '',
    previewPriority,
    notifiedAt: timestampValue(options.updatedAt),
  };
}

function normalizeProgressRecord(progress, details, options = {}) {
  return normalizeResultRecord({ progress, index: progress?.index }, details, options);
}

function toolDetails(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  if (payload.details && typeof payload.details === 'object') return payload.details;
  if (Array.isArray(payload.results) || Array.isArray(payload.progress)) return payload;
  return undefined;
}

function subagentToolName(name) {
  if (typeof name !== 'string') return false;
  return name === 'subagent' || name === 'subagents' || name.endsWith(':subagent');
}

/** Normalize one tool result or streamed tool update. */
function recordsFromToolPayload(payload, options = {}) {
  const details = toolDetails(payload);
  if (!details) return [];
  const records = [];
  const results = Array.isArray(details.results) ? details.results : [];
  for (let index = 0; index < results.length; index += 1) {
    records.push(normalizeResultRecord(results[index], details, { ...options, index }));
  }
  const progressRows = Array.isArray(details.progress) ? details.progress : [];
  for (let index = 0; index < progressRows.length; index += 1) {
    records.push(normalizeProgressRecord(progressRows[index], details, { ...options, index }));
  }
  return records;
}

function notificationRecords(entry, options = {}) {
  if (entry?.type !== 'custom_message' || entry.customType !== 'subagent-notify') return [];
  const runs = Array.isArray(entry.details?.runs) ? entry.details.runs : [];
  const records = [];
  for (const run of runs) {
    const outputs = Array.isArray(run.childOutputs) && run.childOutputs.length
      ? run.childOutputs
      : [{ agent: run.agent, status: run.status }];
    for (let index = 0; index < outputs.length; index += 1) {
      const output = outputs[index] || {};
      const runId = text(output.runId || run.runId || run.workflowRunId, 240);
      const agent = text(output.agent || run.agent || 'agent', 100);
      const task = text(run.taskInfo || output.task || run.sessionLabel || `${agent} 子 Agent`, 2_000);
      const error = text(output.error || (output.status === 'failed' ? run.resultPreview : ''), 1_200) || undefined;
      records.push({
        public: {
          key: childIdentity({ runId, toolCallId: run.runId, agent, task, index }),
          runId,
          index,
          agent,
          task,
          status: normalizedStatus(output.status || run.status, { error }),
          source: normalizeSource(run.source, 'background'),
          context: normalizeContext(run.context, undefined),
          model: '',
          thinking: '',
          cwd: text(options.cwd || '', 2_048),
          startedAt: timestampValue(run.startedAt),
          updatedAt: timestampValue(options.updatedAt || entry.timestamp) || Date.now(),
          durationMs: finiteNumber(run.durationMs),
          tokens: undefined,
          toolCount: undefined,
          turnCount: undefined,
          currentTool: undefined,
          preview: text(output.preview || run.resultPreview || error || '', MAX_PREVIEW),
          error,
          hasTranscript: false,
        },
        sessionFile: typeof output.sessionFile === 'string'
          ? output.sessionFile
          : typeof run.sessionValue === 'string' && path.isAbsolute(run.sessionValue) && path.extname(run.sessionValue) === '.jsonl'
            ? run.sessionValue
            : '',
        transcriptPath: typeof output.transcriptPath === 'string' ? output.transcriptPath : '',
        notifiedAt: timestampValue(options.updatedAt || entry.timestamp),
      });
    }
  }
  return records;
}

function realDirectory(file) {
  try { return fs.realpathSync.native(path.dirname(file)); }
  catch { return path.resolve(path.dirname(file)); }
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function realFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return fs.realpathSync.native(file);
  } catch {
    return undefined;
  }
}

function childSessionRoot(parentSessionFile) {
  if (typeof parentSessionFile !== 'string' || path.extname(parentSessionFile) !== '.jsonl') return undefined;
  return path.join(realDirectory(parentSessionFile), path.basename(parentSessionFile, '.jsonl'));
}

function findRunSession(root, runId, index) {
  if (!root || !stableRunId(runId)) return undefined;
  const runRoot = path.join(root, runId);
  const direct = path.join(runRoot, `run-${index}`, 'session.jsonl');
  const directReal = realFile(direct);
  if (directReal) return directReal;
  const fallback = realFile(path.join(runRoot, 'session.jsonl'));
  if (fallback) return fallback;
  return undefined;
}

/**
 * A renderer only receives a stable child key. Resolve the actual transcript
 * path in the main process and reject every candidate outside this parent
 * session's pi-subagents directory.
 */
function resolveTrustedTranscript(record, parentSessionFile) {
  const root = childSessionRoot(parentSessionFile);
  if (!root) return undefined;
  let rootReal;
  try { rootReal = fs.realpathSync.native(root); }
  catch { rootReal = path.resolve(root); }
  const candidates = [
    record.sessionFile,
    findRunSession(rootReal, record.public.runId, record.public.index),
  ].filter((value) => typeof value === 'string' && value);
  for (const candidate of candidates) {
    const resolved = realFile(candidate);
    if (resolved && within(rootReal, resolved)) return resolved;
  }
  return undefined;
}

function clonePublic(child) {
  return { ...child };
}

function mergeRecord(target, incoming) {
  if (!target) return incoming;
  const next = { ...target };
  const incomingPreviewPriority = incoming.previewPriority ?? 0;
  const currentPreviewPriority = next.previewPriority ?? 0;
  for (const [key, value] of Object.entries(incoming.public)) {
    if (value === undefined || value === '' || value === null) continue;
    if (key === 'status') next.public.status = mergeStatus(next.public.status, value);
    else if (key === 'preview' && incomingPreviewPriority < currentPreviewPriority) continue;
    else if (key === 'tokens') next.public.tokens = Math.max(next.public.tokens || 0, value);
    else if (key === 'toolCount') next.public.toolCount = Math.max(next.public.toolCount || 0, value);
    else if (key === 'durationMs') next.public.durationMs = Math.max(next.public.durationMs || 0, value);
    else next.public[key] = value;
  }
  if (incoming.sessionFile) next.sessionFile = incoming.sessionFile;
  if (incoming.transcriptPath) next.transcriptPath = incoming.transcriptPath;
  if (incomingPreviewPriority >= currentPreviewPriority) next.previewPriority = incomingPreviewPriority;
  if (incoming.notifiedAt) next.notifiedAt = incoming.notifiedAt;
  return next;
}

function mergeRecordLists(...lists) {
  const merged = new Map();
  for (const records of lists) {
    for (const record of records || []) {
      const current = merged.get(record.public.key);
      merged.set(record.public.key, mergeRecord(current, record));
    }
  }
  return [...merged.values()].slice(-MAX_CHILDREN);
}

function publicChildren(records, parentSessionFile) {
  return records.map((record) => ({
    ...clonePublic(record.public),
    hasTranscript: Boolean(resolveTrustedTranscript(record, parentSessionFile)),
  }));
}

function historyRecords(manager, cwd) {
  const records = [];
  for (const entry of manager?.getEntries?.() || []) {
    if (entry.type === 'message') {
      const message = entry.message;
      if (message?.role === 'toolResult' && subagentToolName(message.toolName)) {
        records.push(...recordsFromToolPayload(
          { details: message.details },
          {
            cwd,
            updatedAt: message.timestamp || entry.timestamp,
            toolCallId: message.toolCallId,
            source: message.details?.background ? 'background' : 'foreground',
          },
        ));
      }
      continue;
    }
    records.push(...notificationRecords(entry, {
      cwd,
      updatedAt: entry.timestamp,
    }));
  }
  return records;
}

function liveRecords(sessionId) {
  return [...(liveChildren.get(sessionId)?.values() || [])];
}

function setLiveRecords(sessionId, records) {
  const merged = mergeRecordLists(liveRecords(sessionId), records);
  liveChildren.set(sessionId, new Map(merged.map((record) => [record.public.key, record])));
  return liveRecords(sessionId);
}

/**
 * Capture a live parent-session event. Returns the updated public child set for
 * immediate UI merge, or undefined when the event is unrelated.
 */
function captureSubagentEvent(sessionId, cwd, parentSessionFile, event) {
  let records = [];
  if (event?.type === 'tool_execution_update' || event?.type === 'tool_execution_end') {
    if (!subagentToolName(event.toolName)) return undefined;
    records = recordsFromToolPayload(event.type === 'tool_execution_update' ? event.partialResult : event.result, {
      cwd,
      updatedAt: Date.now(),
      toolCallId: event.toolCallId,
      source: 'foreground',
    });
  } else if (event?.type === 'entry_appended') {
    records = notificationRecords(event.entry, { cwd, updatedAt: Date.now() });
  }
  if (!records.length) return undefined;
  return publicChildren(setLiveRecords(sessionId, records), parentSessionFile);
}

/** Merge persisted tool results / notifications with current live snapshots. */
function sessionSubagents(sessionId, cwd, manager) {
  const parentSessionFile = manager?.getSessionFile?.();
  const records = mergeRecordLists(historyRecords(manager, cwd), liveRecords(sessionId));
  return publicChildren(records, parentSessionFile);
}

function transcriptWindow(entries, limit) {
  const total = entries.length;
  if (!Number.isInteger(limit) || limit <= 0 || total <= limit) {
    return { entries, startIndex: 0, total, hasMore: false };
  }
  let startIndex = total - limit;
  let window = entries.slice(startIndex);
  const firstUser = window.findIndex((entry) => entry.message?.role === 'user');
  if (firstUser > 0) {
    startIndex += firstUser;
    window = window.slice(firstUser);
  }
  return { entries: window, startIndex, total, hasMore: startIndex > 0 };
}

/** Open a trusted child session and serialize its active transcript. */
function subagentTranscript(sessionId, childKey, cwd, manager, limit = MAX_TRANSCRIPT_MESSAGES) {
  const parentSessionFile = manager?.getSessionFile?.();
  const records = mergeRecordLists(historyRecords(manager, cwd), liveRecords(sessionId));
  const record = records.find((item) => item.public.key === childKey);
  if (!record) throw new Error('子 Agent 记录已不存在，请刷新后重试。');
  const sessionFile = resolveTrustedTranscript(record, parentSessionFile);
  if (!sessionFile) throw new Error('这个子 Agent 没有可安全读取的本地会话。');

  const pi = piModule();
  const childManager = pi.SessionManager.open(sessionFile, undefined, cwd);
  const sourceEntries = (childManager.getBranch?.() || childManager.getEntries())
    .filter((entry) => entry.type === 'message');
  const window = transcriptWindow(sourceEntries, Math.min(Math.max(Number(limit) || MAX_TRANSCRIPT_MESSAGES, 1), MAX_TRANSCRIPT_MESSAGES));
  const messages = visibleSessionMessages(
    window.entries
      .map((entry, index) => {
        const message = serializeMessage(entry.message);
        return message ? { ...message, sourceIndex: window.startIndex + index } : null;
      })
      .filter(Boolean),
  );
  return {
    child: publicChildren([record], parentSessionFile)[0],
    messages,
    totalMessages: window.total,
    hasMore: window.hasMore,
    messageStart: window.startIndex,
  };
}

function clearSubagentRuntime(sessionId) {
  if (sessionId) liveChildren.delete(sessionId);
}

module.exports = {
  MAX_CHILDREN,
  MAX_TRANSCRIPT_MESSAGES,
  captureSubagentEvent,
  childIdentity,
  clearSubagentRuntime,
  mergeRecordLists,
  normalizedStatus,
  notificationRecords,
  recordsFromToolPayload,
  resolveTrustedTranscript,
  sessionSubagents,
  subagentTranscript,
  subagentToolName,
};
