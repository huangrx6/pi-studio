const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-subagent-state-'));
process.env.PI_STUDIO_USER_DATA = temporary;
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const {
  resolveSubagentStatus,
} = require('../../electron/services/durable-subagents.cjs');

test.after(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('an owned terminal task overrides a stale live run', () => {
  assert.equal(resolveSubagentStatus({
    taskStatusValue: 'failed',
    liveRunning: true,
    cachedStatus: 'running',
  }), 'failed');
  assert.equal(resolveSubagentStatus({
    taskStatusValue: 'completed',
    liveRunning: true,
    cachedStatus: 'running',
  }), 'completed');
});

test('live work only wins while every task projection is non-terminal', () => {
  assert.equal(resolveSubagentStatus({
    taskStatusValue: 'pending',
    liveRunning: true,
    cachedStatus: 'completed',
  }), 'running');
  assert.equal(resolveSubagentStatus({
    taskStatusValue: 'running',
    liveRunning: false,
    cachedStatus: 'completed',
  }), 'running');
  assert.equal(resolveSubagentStatus({
    taskStatusValue: 'pending',
    liveRunning: false,
    cachedStatus: 'completed',
  }), 'completed');
});

test('a stale pending supervisor request cannot reopen a terminal child', () => {
  assert.equal(resolveSubagentStatus({
    taskStatusValue: 'failed',
    liveRunning: false,
    cachedStatus: 'waiting',
    supervisorPending: 1,
  }), 'failed');
  assert.equal(resolveSubagentStatus({
    taskStatusValue: 'pending',
    liveRunning: false,
    cachedStatus: 'running',
    supervisorPending: 1,
  }), 'waiting');
});
