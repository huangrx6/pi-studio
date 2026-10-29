const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-subagents-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const {
  hasAvailableSubagentExtension,
  normalizeConfig,
  saveSubagentSettings,
  subagentSettings,
} = require('../../electron/services/subagent-settings.cjs');
const {
  getSubagentConfig,
  setSubagentConfig,
} = require('../../electron/core/app-settings.cjs');
const { closeStudioDatabase } = require('../../electron/core/studio-db.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('subagent config accepts supported values and rejects contradictory limits', () => {
  const input = JSON.parse(`{
    "defaultModel": " provider/model ",
    "defaultThinking": "high",
    "maxThinking": "turbo",
    "allowedTools": ["read", "read", "bad tool", "subagent"]
  }`);
  assert.deepEqual(normalizeConfig(input), {
    defaultModel: 'provider/model',
    defaultProvider: 'provider',
    defaultThinking: 'high',
    maxThinking: '',
    allowedTools: ['read', 'subagent'],
    backgroundEnabled: true,
    defaultMode: 'foreground',
    supervisorEnabled: true,
    maxConcurrent: 4,
    maxSpawns: 32,
    waitTimeoutMs: 30_000,
  });
  assert.throws(
    () => normalizeConfig({ defaultThinking: 'high', maxThinking: 'low' }),
    /默认 thinking 不能高于/,
  );
});

test('builtin subagent readiness follows the manifest id behind a scoped host row', () => {
  assert.equal(hasAvailableSubagentExtension([{
    id: 'builtin:studio-subagents',
    scope: 'builtin',
    manifest: { id: 'studio-subagents' },
    enabled: true,
    available: true,
  }]), true);
  assert.equal(hasAvailableSubagentExtension([{
    id: 'builtin:studio-subagents',
    scope: 'builtin',
    manifest: { id: 'studio-subagents' },
    enabled: true,
    available: false,
  }]), false);
});

test('subagent defaults persist in Studio SQLite by user and workspace scope', async () => {
  const workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(workspace);

  const user = await saveSubagentSettings(workspace, 'user', {
    defaultModel: 'provider/fast',
    defaultThinking: 'medium',
    maxThinking: 'high',
    allowedTools: ['read', 'grep'],
  });
  assert.equal(user.user.defaultModel, 'provider/fast');
  assert.equal(user.user.defaultThinking, 'medium');
  assert.deepEqual(user.user.allowedTools, ['read', 'grep']);
  assert.equal(user.user.backgroundEnabled, true);
  assert.equal(user.user.defaultMode, 'foreground');
  assert.equal(user.user.supervisorEnabled, true);
  assert.equal(user.user.maxConcurrent, 4);

  const project = await saveSubagentSettings(workspace, 'project', {
    defaultModel: 'provider/project',
    defaultThinking: 'low',
  });
  assert.equal(project.project.defaultModel, 'provider/project');
  assert.equal(project.project.defaultThinking, 'low');

  assert.equal(getSubagentConfig('user').defaultModel, 'provider/fast');
  assert.equal(getSubagentConfig('project', workspace).defaultModel, 'provider/project');

  setSubagentConfig('user', '', {
    ...getSubagentConfig('user'),
    defaultThinking: 'xhigh',
    maxThinking: 'xhigh',
  });
  assert.equal((await subagentSettings(workspace)).user.defaultThinking, 'xhigh');
});

test('subagent runtime controls are normalized and bounded', () => {
  assert.deepEqual(normalizeConfig({
    backgroundEnabled: false,
    defaultMode: 'background',
    supervisorEnabled: true,
    maxConcurrent: 6,
    maxSpawns: 12,
    waitTimeoutMs: 45_000,
  }), {
    defaultModel: '',
    defaultProvider: '',
    defaultThinking: '',
    maxThinking: '',
    allowedTools: [],
    backgroundEnabled: false,
    defaultMode: 'foreground',
    supervisorEnabled: false,
    maxConcurrent: 6,
    maxSpawns: 12,
    waitTimeoutMs: 45_000,
  });
  assert.throws(
    () => normalizeConfig({ maxConcurrent: 0 }),
    /整数/,
  );
  assert.throws(
    () => normalizeConfig({ waitTimeoutMs: 601_000 }),
    /整数/,
  );
});

test('project subagent settings reject a relative workspace', () => {
  assert.throws(
    () => saveSubagentSettings('relative/path', 'project', {}),
    /工作区无效/,
  );
});
