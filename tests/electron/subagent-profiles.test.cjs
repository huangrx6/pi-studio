const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-role-library-'));
process.env.PI_STUDIO_USER_DATA = directory;
process.env.PI_STUDIO_DB = path.join(directory, 'studio.sqlite');
const { closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const { listSubagentProfiles, removeSubagentProfile, resolveProfileMentions, roleHarness, saveSubagentProfile } =
  require('../../electron/main/capabilities/subagents/index.cjs');
after(() => { closeStudioDatabase(); fs.rmSync(directory, { recursive: true, force: true }); });

test('saved roles survive reopen, rename, concurrent editing and deletion without stale draft routing', () => {
  const starters = listSubagentProfiles();
  assert.equal(starters.length, 2);
  const draft = { ...starters[0], name: '审阅 [A] 100%', id: '', avatarId: 'silver-pixie',
    model: 'studio/review', harnessId: '', skills: [], mcpServers: ['manuals', 'manuals'] };
  const role = saveSubagentProfile(draft).at(-1);
  assert.deepEqual(role.mcpServers, ['manuals']);
  assert.deepEqual(role.skills, []);
  assert.equal(role.revision, 1);
  closeStudioDatabase();
  assert.deepEqual(listSubagentProfiles().at(-1), role);
  assert.throws(() => saveSubagentProfile(draft), /同名/);
  assert.throws(() => saveSubagentProfile({ ...role, skills: {} }), /选择无效/);
  assert.throws(() => roleHarness({ ...role, harnessId: 'deleted-harness' }, directory), /已不存在/);
  const updated = saveSubagentProfile({ ...role, name: '复核 | 资料', avatarId: 'ebony-coils', skills: null }).at(-1);
  assert.equal(updated.id, role.id);
  assert.equal(updated.revision, 2);
  assert.throws(() => saveSubagentProfile(role), /已经更新/);
  assert.throws(() => removeSubagentProfile(role), /已经更新/);
  const old = '@[agent:' + role.id + '|silver-pixie|old]';
  const filename = '@' + JSON.stringify('docs/' + old + ' draft.md');
  const text = '请' + old + ' 检查 ' + filename + ' 并回复 ' + old;
  const result = resolveProfileMentions(text, true);
  const hash = '#' + old.slice(1);
  const current = resolveProfileMentions(hash, true);
  assert.match(current.readable, /^#复核/);
  assert.equal(current.routing, result.routing);
  assert.equal(resolveProfileMentions(hash + ' ' + old, true).routing, current.routing);
  assert.equal(result.readable, '请@复核 | 资料 检查 ' + filename + ' 并回复 @复核 | 资料');
  assert.ok(result.display.includes('|ebony-coils|复核 %7C 资料]'));
  assert.equal(result.routing.split('\n').filter(row => row.includes(role.id)).length, 1);
  assert.throws(() => resolveProfileMentions(text, false), /启用 subagent/);
  removeSubagentProfile(updated);
  assert.throws(() => resolveProfileMentions(text, true), /已不存在/);
  assert.deepEqual(resolveProfileMentions(filename, false), { display: filename, readable: filename, routing: '' });
  for (const starter of starters) removeSubagentProfile(starter);
  closeStudioDatabase();
  assert.deepEqual(listSubagentProfiles(), []);
});

test('the three portrait families each ship sixteen different selectable assets', () => {
  const groups = require('../../assets/settings/subagent-avatars.json');
  const ids = Object.values(groups).flatMap(group => Object.keys(group));
  assert.deepEqual(Object.keys(groups), ['girls', 'boys', 'animals']);
  assert.ok(Object.values(groups).every(group => Object.keys(group).length === 16));
  assert.equal(new Set(ids).size, 48);
  const dir = path.join(__dirname, '../../web/src/features/subagents/avatars');
  const contents = ids.map(id => fs.readFileSync(path.join(dir, id + '.webp')));
  assert.ok(contents.every(file => file.toString('ascii', 8, 12) === 'WEBP'));
  assert.equal(new Set(contents.map(file => require('node:crypto').createHash('sha256').update(file).digest('hex'))).size, 48);
});

test('role overrides stay sparse across save, legacy edits and changes to workspace defaults', () => {
  const { normalizeRoleOverrides, resolveRoleDefaults } = require('../../electron/main/core/subagent-config.cjs');
  const draft = { name: '值继承检查', avatarId: 'indigo-bob', model: 'parent', description: '配置验证', instructions: '',
    mcpServers: null, skills: null, harnessId: '' };
  const shared = { allowedTools: ['read'], budgetTokens: 2000, defaultThinking: 'high', maxSpawns: 6 };
  const project = { maxSpawns: 3 };
  const first = saveSubagentProfile(draft).at(-1);
  assert.deepEqual(first.runtimeOverrides, {});
  const overrides = { allowedTools: [], budgetTokens: 0, backgroundEnabled: false, defaultThinking: '', waitTimeoutMs: 12500 };
  const updated = saveSubagentProfile({ ...first, runtimeOverrides: overrides }).at(-1);
  closeStudioDatabase();
  const { runtimeOverrides, ...legacyEditor } = listSubagentProfiles().at(-1);
  assert.deepEqual(runtimeOverrides, overrides);
  assert.deepEqual(saveSubagentProfile({ ...legacyEditor, name: '旧版编辑' }).at(-1).runtimeOverrides, overrides);
  const run = resolveRoleDefaults(shared, project, overrides);
  for (const [key, value] of Object.entries(overrides)) assert.deepEqual(run[key], value);
  assert.equal(run.maxSpawns, 3);
  assert.equal(resolveRoleDefaults(shared, { maxSpawns: 8 }, overrides).maxSpawns, 8);
  const current = listSubagentProfiles().find(row => row.id === updated.id);
  const reset = saveSubagentProfile({ ...current, runtimeOverrides: {} }).at(-1);
  assert.equal(resolveRoleDefaults(shared, project, reset.runtimeOverrides).budgetTokens, 2000);
  for (const invalid of [{ defaultThinking: 'extreme' }, { budgetTokens: -1 }, { worktreeParent: 'relative' },
    { maxConcurrent: 1.5 }, { allowedTools: ['mcp__manual__write'] }, { allowedTools: ['subagent_stop'] },
    { defaultThinking: 'high', maxThinking: 'low' }, { allowedTools: 'all' }, { backgroundEnabled: 0 }]) {
    assert.throws(() => normalizeRoleOverrides(invalid));
  }
});

test('role tools intersect every parent tool surface, including deferred MCP and shadowed file tools', () => {
  const { childToolsFor, childExtensionsFor } = require('../../electron/main/capabilities/subagents/role-runtime.cjs');
  const { resolveRoleDefaults } = require('../../electron/main/core/subagent-config.cjs');
  const tool = name => ({ name });
  const docs = { name: 'mcp__docs__lookup', deferred: true };
  const other = { name: 'mcp__other__create', deferred: true };
  const extensions = [
    { name: 'coding-tools', tools: ['read', 'write', 'bash'].map(tool) },
    { name: 'studio-filesystem-tools', tools: ['ls', 'grep'].map(tool) },
    { name: 'studio-mcp:docs', tools: [docs] }, { name: 'studio-mcp:other', tools: [other] },
    { name: 'studio-mcp-catalog', tools: [] }, { name: 'tool-search', tools: [tool('tool_search')] },
  ];
  const parent = { extensions, tools: ['read', 'write', 'tool_search'].map(tool),
    callable: ['read', 'write', 'bash', 'ls'].map(tool), deferred: [docs, other] };
  const select = (allowedTools, agent = parent) => {
    const role = { mcpServers: ['docs'], runtimeOverrides: { allowedTools } };
    const defaults = resolveRoleDefaults({ allowedTools: ['read'] }, {}, role.runtimeOverrides);
    return childToolsFor(agent, defaults, null, role);
  };
  const names = tools => tools.map(t => t.name).sort();
  assert.deepEqual(names(select('read-only').enabledTools), ['ls', 'read']);
  assert.deepEqual(names(select('read-write').enabledTools), ['ls', 'read', 'write']);
  assert.deepEqual(names(select('read-write').modelTools), ['read', 'write']);
  assert.deepEqual(names(select('parent').enabledTools), ['bash', 'ls', 'mcp__docs__lookup', 'read', 'tool_search', 'write']);
  assert.deepEqual(names(select([]).enabledTools), ['mcp__docs__lookup', 'tool_search']);
  const shadowed = { ...parent, extensions: [...extensions, { name: 'external', tools: [tool('read'), docs] }] };
  assert.deepEqual(names(select('read-only', shadowed).enabledTools), ['ls']);
  assert.deepEqual(names(select([], shadowed).enabledTools), []);
  const channel = { name: 'studio-subagent-channel' };
  assert.ok(!childExtensionsFor(parent, { runtimeOverrides: { allowedTools: 'read-only' } }, channel)
    .some(extension => extension.name.startsWith('studio-mcp')));
});

test('role budget and spawn overrides count that role in the invoking conversation', () => {
  const { assertBudgetAvailable, assertSpawnAvailable } = require('../../electron/main/capabilities/subagents/role-runtime.cjs');
  const { getStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
  const state = { agents: { a: { profileId: 'review', conversationId: 31 }, b: { profileId: 'write', conversationId: 32 } } };
  const db = getStudioDatabase();
  db.recordMetricRequest({ requestId: 'role-review', conversationId: '31', input: 5 });
  db.recordMetricRequest({ requestId: 'role-write', conversationId: '32', input: 200 });
  const defaults = { budgetTokens: 10, budgetAction: 'stop', maxSpawns: 2 };
  const profile = { id: 'review', name: '审阅', runtimeOverrides: defaults };
  assert.equal(assertBudgetAvailable(1, defaults, state, profile).tokens, 5);
  assert.doesNotThrow(() => assertSpawnAvailable(defaults, state, profile));
  assert.throws(() => assertBudgetAvailable(1, defaults, state, null), /预算已用尽/);
  assert.throws(() => assertSpawnAvailable(defaults, state, null), /最多创建/);
  db.recordMetricRequest({ requestId: 'role-review-more', conversationId: '31', input: 6 });
  assert.match(assertBudgetAvailable(1, { ...defaults, budgetAction: 'warn' }, state, profile).warning, /审阅/);
  assert.throws(() => assertBudgetAvailable(1, defaults, state, profile), /审阅/);
});
