const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  captureSubagentEvent,
  clearSubagentRuntime,
  mergeRecordLists,
  notificationRecords,
  recordsFromToolPayload,
  resolveTrustedTranscript,
  sessionSubagents,
  subagentTranscript,
} = require('../electron/services/subagent-runtime.cjs');

function managerFor(entries, sessionFile) {
  return {
    getEntries: () => entries,
    getSessionFile: () => sessionFile,
  };
}

test('foreground tool results merge with the latest progress snapshot', () => {
  const payload = {
    details: {
      runId: 'parallel-run',
      toolCallId: 'tool-call',
      context: 'fresh',
      results: [{
        index: 0,
        agent: 'worker',
        task: 'Inspect the renderer',
        exitCode: 0,
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, turns: 2 },
        model: 'provider/model',
        thinking: 'high',
        finalOutput: 'Result ready',
      }],
      progress: [{
        index: 0,
        agent: 'worker',
        task: 'Inspect the renderer',
        status: 'completed',
        durationMs: 1_250,
        tokens: 35,
        toolCount: 4,
        turnCount: 2,
        model: 'provider/model',
        thinking: 'high',
        recentOutput: ['streamed line'],
      }],
    },
  };
  const records = mergeRecordLists(recordsFromToolPayload(payload, { cwd: '/tmp/project' }));
  assert.equal(records.length, 1);
  assert.deepEqual({
    key: records[0].public.key,
    agent: records[0].public.agent,
    status: records[0].public.status,
    context: records[0].public.context,
    model: records[0].public.model,
    thinking: records[0].public.thinking,
    durationMs: records[0].public.durationMs,
    tokens: records[0].public.tokens,
    toolCount: records[0].public.toolCount,
    turnCount: records[0].public.turnCount,
    preview: records[0].public.preview,
  }, {
    key: 'parallel-run:0',
    agent: 'worker',
    status: 'completed',
    context: 'fresh',
    model: 'provider/model',
    thinking: 'high',
    durationMs: 1_250,
    tokens: 35,
    toolCount: 4,
    turnCount: 2,
    preview: 'Result ready',
  });
});

test('live status never regresses after a completed event', () => {
  clearSubagentRuntime('status-session');
  const running = {
    type: 'tool_execution_update',
    toolName: 'subagent',
    toolCallId: 'tool-call',
    partialResult: {
      details: {
        runId: 'status-run',
        results: [{
          index: 0,
          agent: 'reviewer',
          task: 'Review changes',
          progress: { index: 0, status: 'running', currentTool: 'read' },
        }],
      },
    },
  };
  const completed = {
    type: 'tool_execution_end',
    toolName: 'subagent',
    toolCallId: 'tool-call',
    result: {
      details: {
        runId: 'status-run',
        results: [{
          index: 0,
          agent: 'reviewer',
          task: 'Review changes',
          exitCode: 0,
          finalOutput: 'Done',
          progress: { index: 0, status: 'completed' },
        }],
      },
    },
  };
  const lateFailure = {
    ...completed,
    result: {
      details: {
        runId: 'status-run',
        results: [{
          index: 0,
          agent: 'reviewer',
          task: 'Review changes',
          exitCode: 1,
          error: 'late duplicate failure',
          progress: { index: 0, status: 'failed' },
        }],
      },
    },
  };

  assert.equal(captureSubagentEvent('status-session', '/tmp/project', undefined, running)[0].status, 'running');
  assert.equal(captureSubagentEvent('status-session', '/tmp/project', undefined, completed)[0].status, 'completed');
  assert.equal(captureSubagentEvent('status-session', '/tmp/project', undefined, running)[0].status, 'completed');
  assert.equal(captureSubagentEvent('status-session', '/tmp/project', undefined, lateFailure)[0].status, 'completed');
  clearSubagentRuntime('status-session');
});

test('background completion records retain a safe child session handle', () => {
  const sessionFile = '/tmp/parent/run-1/run-0/session.jsonl';
  const records = notificationRecords({
    type: 'custom_message',
    customType: 'subagent-notify',
    timestamp: 1_700_000_000_000,
    details: {
      runs: [{
        agent: 'explorer',
        status: 'completed',
        source: 'async',
        taskInfo: 'Find relevant files',
        resultPreview: 'Found three files',
        durationMs: 2_400,
        runId: 'async-run',
        sessionLabel: 'Session file',
        sessionValue: sessionFile,
      }],
    },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].sessionFile, sessionFile);
  assert.equal(records[0].public.source, 'background');
  assert.equal(records[0].public.status, 'completed');
  assert.equal(records[0].public.task, 'Find relevant files');
  assert.equal(records[0].public.preview, 'Found three files');
  assert.equal(records[0].public.durationMs, 2_400);
});

test('child transcript lookup rejects paths outside the parent session directory', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-subagent-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const sessions = path.join(temp, 'sessions');
  const parentSession = path.join(sessions, 'parent.jsonl');
  const childRoot = path.join(sessions, 'parent');
  fs.mkdirSync(childRoot, { recursive: true });
  const outside = path.join(temp, 'outside.jsonl');
  fs.writeFileSync(outside, '{}\n');

  const traversal = {
    public: { runId: 'missing-run', index: 0 },
    sessionFile: outside,
  };
  assert.equal(resolveTrustedTranscript(traversal, parentSession), undefined);

  const derived = path.join(childRoot, 'safe-run', 'run-0', 'session.jsonl');
  fs.mkdirSync(path.dirname(derived), { recursive: true });
  fs.writeFileSync(derived, '{}\n');
  assert.equal(
    resolveTrustedTranscript({ public: { runId: 'safe-run', index: 0 }, sessionFile: outside }, parentSession),
    fs.realpathSync.native(derived),
  );

  const linked = path.join(childRoot, 'linked-run', 'run-0', 'session.jsonl');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.symlinkSync(outside, linked);
  assert.equal(
    resolveTrustedTranscript({ public: { runId: 'linked-run', index: 0 }, sessionFile: '' }, parentSession),
    undefined,
  );
});

test('history exposes transcript availability without leaking session paths', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-subagent-history-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const sessions = path.join(temp, 'sessions');
  const parentSession = path.join(sessions, 'parent.jsonl');
  const childSession = path.join(sessions, 'parent', 'history-run', 'run-0', 'session.jsonl');
  fs.mkdirSync(path.dirname(childSession), { recursive: true });
  fs.writeFileSync(childSession, '{}\n');

  const entry = {
    type: 'message',
    timestamp: 1_700_000_000_000,
    message: {
      role: 'toolResult',
      toolName: 'subagent',
      toolCallId: 'history-tool',
      timestamp: 1_700_000_000_000,
      details: {
        runId: 'history-run',
        results: [{ index: 0, agent: 'scout', task: 'Check history', exitCode: 0 }],
      },
    },
  };
  const manager = managerFor([entry], parentSession);
  const children = sessionSubagents('history-session', temp, manager);
  assert.equal(children.length, 1);
  assert.equal(children[0].hasTranscript, true);
  assert.equal(Object.hasOwn(children[0], 'sessionFile'), false);

  const missingManager = managerFor([entry], undefined);
  const missing = sessionSubagents('missing-session', temp, missingManager);
  assert.equal(missing[0].hasTranscript, false);
  assert.throws(
    () => subagentTranscript('missing-session', missing[0].key, temp, missingManager),
    /没有可安全读取的本地会话/,
  );
});
