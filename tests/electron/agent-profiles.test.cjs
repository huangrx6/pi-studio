const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-agent-profiles-'));
const dbFile = path.join(tmpRoot, 'studio.sqlite');
const userData = path.join(tmpRoot, 'user-data');
fs.mkdirSync(userData, { recursive: true });
process.env.PI_STUDIO_DB = dbFile;
process.env.PI_STUDIO_USER_DATA = userData;

const { closeStudioDatabase, getStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const { runtimeToolFilter } = require('../../electron/main/runtime/tool-selection.cjs');
const {
  MAIN_DEFAULT_PROFILE_ID,
  TEMPORARY_DEFAULT_PROFILE_ID,
  deleteToolProfile,
  getToolProfilesSnapshot,
  readAgentToolSelection,
  resetToolProfile,
  resolveMainToolProfile,
  resolveTemporaryToolProfile,
  saveInstalledToolSelection,
  saveToolProfile,
  selectToolProfile,
} = require('../../electron/main/core/tool-profiles.cjs');
const {
  DEFAULT_PERMISSION_PROFILE_IDS,
  deleteHarnessProfile,
  deletePermissionProfile,
  deleteWorkspaceScopedSettings,
  getHarnessProfile,
  getPermissionPolicyStore,
  getPermissionProfilesSnapshot,
  getTemporaryHarnessProfile,
  getTemporaryPermissionPolicy,
  resetPermissionProfile,
  saveHarnessProfile,
  savePermissionProfile,
  selectHarnessProfile,
  selectPermissionProfile,
  setPermissionPolicy,
} = require('../../electron/main/core/app-settings.cjs');
const {
  evaluateTemporaryToolCall,
  previewProfileToolCall,
} = require('../../electron/main/capabilities/permissions/mode.cjs');
const {
  listSubagentProfiles,
  removeSubagentProfile,
  saveSubagentProfile,
} = require('../../electron/main/capabilities/subagents/profiles.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('tool profiles support create, workspace override, temporary binding, legacy sync, and cleanup', async () => {
  const workspaceDir = path.join(tmpRoot, 'workspace-a');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const initial = getToolProfilesSnapshot(workspaceDir);
  assert.equal(initial.mainProfileId, MAIN_DEFAULT_PROFILE_ID);
  assert.equal(initial.temporaryProfileId, TEMPORARY_DEFAULT_PROFILE_ID);
  assert.equal(initial.profiles.length, 2);

  const created = saveToolProfile({
    cwd: workspaceDir,
    mode: 'create',
    profile: {
      id: 'temp-mcp-reader',
      name: '临时只读与 Fetch',
      description: '用于临时对话的受控 MCP 方案',
      enabled: ['read', 'grep', 'find'],
      sources: {},
      extensionMode: 'safe-only',
      mcpMode: 'picked',
      mcpServers: ['fetch'],
    },
  });
  assert.ok(created.profiles.some((item) => item.id === 'temp-mcp-reader'));

  const boundTemp = selectToolProfile({ cwd: workspaceDir, id: 'temp-mcp-reader', scope: 'temporary' });
  assert.equal(boundTemp.temporaryProfileId, 'temp-mcp-reader');
  const resolvedTemp = resolveTemporaryToolProfile();
  assert.deepEqual(resolvedTemp.enabled, ['read', 'grep', 'find']);
  assert.equal(resolvedTemp.mcpMode, 'picked');
  assert.deepEqual(resolvedTemp.mcpServers, ['fetch']);

  // Empty temporary profile blocks all tools even when extensionMode is safe-only.
  selectToolProfile({ cwd: workspaceDir, id: TEMPORARY_DEFAULT_PROFILE_ID, scope: 'temporary' });
  const tempProfile = resolveTemporaryToolProfile();
  const mockExtSnapshot = {
    extensions: [
      { id: 'builtin:coding', scope: 'builtin', manifest: { runtimeNames: ['coding-tools'] } },
      { id: 'user:studio.task-board', scope: 'user', manifest: { runtimeName: 'studio-task-board' } },
    ],
  };
  const emptyFilter = runtimeToolFilter(
    { enabled: [], sources: {} },
    { tools: [], catalogRuntimeName: 'studio-mcp-catalog' },
    tempProfile,
    {
      extensionSnapshot: mockExtSnapshot,
      safeEntries: [{ extension: { name: 'studio-task-board' }, toolNames: ['task_board_list'] }],
    },
  );
  assert.equal(emptyFilter({ extension: { name: 'coding-tools' }, tool: { name: 'read' } }), false);
  assert.equal(emptyFilter({ extension: { name: 'studio-task-board' }, tool: { name: 'task_board_list' } }), false);

  // Explicit selection obeys extensionMode ('safe-only' allows safe tool, blocks write tool).
  const safeFilter = runtimeToolFilter(
    { enabled: [], sources: {} },
    { tools: [], catalogRuntimeName: 'studio-mcp-catalog' },
    { ...tempProfile, enabled: ['read', 'task_board_list', 'task_board_create'] },
    {
      extensionSnapshot: mockExtSnapshot,
      safeEntries: [{ extension: { name: 'studio-task-board' }, toolNames: ['task_board_list'] }],
    },
  );
  assert.equal(safeFilter({ extension: { name: 'coding-tools' }, tool: { name: 'read' } }), true);
  assert.equal(safeFilter({ extension: { name: 'studio-task-board' }, tool: { name: 'task_board_list' } }), true);
  assert.equal(safeFilter({ extension: { name: 'studio-task-board' }, tool: { name: 'task_board_create' } }), false);

  const boundWs = selectToolProfile({ cwd: workspaceDir, id: 'temp-mcp-reader', scope: 'workspace' });
  assert.equal(boundWs.workspaceProfileId, 'temp-mcp-reader');
  assert.equal(resolveMainToolProfile(workspaceDir).id, 'temp-mcp-reader');

  // Legacy write still syncs active global main profile.
  saveInstalledToolSelection({ enabled: ['read', 'edit'], sources: {} });
  assert.deepEqual(readAgentToolSelection().enabled, ['read', 'edit']);
  assert.deepEqual(resolveMainToolProfile('').enabled, ['read', 'edit']);

  // Deleting custom profile falls back both workspace and temporary bindings.
  const afterDelete = deleteToolProfile({ cwd: workspaceDir, id: 'temp-mcp-reader' });
  assert.equal(afterDelete.temporaryProfileId, TEMPORARY_DEFAULT_PROFILE_ID);
  assert.equal(afterDelete.workspaceProfileId, '');

  // Resetting builtin restores defaults.
  saveToolProfile({
    mode: 'edit',
    profile: {
      ...initial.profiles.find((p) => p.id === MAIN_DEFAULT_PROFILE_ID),
      enabled: ['read'],
    },
  });
  const reset = resetToolProfile({ id: MAIN_DEFAULT_PROFILE_ID });
  const restored = reset.profiles.find((p) => p.id === MAIN_DEFAULT_PROFILE_ID);
  assert.ok(restored.enabled.includes('bash'));
});

test('permission profiles support CRUD, bindings, preview, temporary evaluation, and workspace deletion', async () => {
  const workspaceDir = path.join(tmpRoot, 'workspace-perm');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const initial = getPermissionProfilesSnapshot(workspaceDir);
  assert.equal(initial.mainProfileId, DEFAULT_PERMISSION_PROFILE_IDS.smart);
  assert.equal(initial.temporaryProfileId, DEFAULT_PERMISSION_PROFILE_IDS.ask);

  const custom = savePermissionProfile({
    cwd: workspaceDir,
    mode: 'create',
    profile: {
      id: 'temp-allow-read',
      name: '临时只读直通',
      description: '临时对话允许 read，拦截 bash',
      policy: {
        version: 1,
        preset: 'ask',
        default: 'ask',
        tools: { read: 'allow', bash: 'deny' },
        rules: [],
      },
    },
  });
  assert.ok(custom.profiles.some((p) => p.id === 'temp-allow-read'));

  selectPermissionProfile({ cwd: workspaceDir, id: 'temp-allow-read', scope: 'temporary' });
  assert.equal(getTemporaryPermissionPolicy().tools.bash, 'deny');

  const evalBash = await evaluateTemporaryToolCall({ name: 'bash', arguments: { command: 'ls' } }, { cwd: workspaceDir });
  assert.equal(evalBash.decision, 'deny');
  assert.deepEqual(evalBash.rememberScopes, ['once']);

  const previewRead = await previewProfileToolCall({
    cwd: workspaceDir,
    policy: custom.profiles.find((p) => p.id === 'temp-allow-read').policy,
    call: { name: 'read', arguments: { path: 'README.md' } },
  });
  assert.equal(previewRead.decision, 'allow');

  selectPermissionProfile({ cwd: workspaceDir, id: 'temp-allow-read', scope: 'workspace' });
  assert.equal(getPermissionProfilesSnapshot(workspaceDir).workspaceProfileId, 'temp-allow-read');
  deleteWorkspaceScopedSettings(workspaceDir);
  assert.equal(getPermissionProfilesSnapshot(workspaceDir).workspaceProfileId, '');

  const afterDel = deletePermissionProfile({ cwd: workspaceDir, id: 'temp-allow-read' });
  assert.equal(afterDel.temporaryProfileId, DEFAULT_PERMISSION_PROFILE_IDS.ask);

  // Resetting builtin smart profile keeps system default intact.
  const reset = resetPermissionProfile({ id: DEFAULT_PERMISSION_PROFILE_IDS.smart });
  assert.equal(reset.profiles.find((p) => p.id === DEFAULT_PERMISSION_PROFILE_IDS.smart).policy.preset, 'smart');

  // Legacy mis-migrated smart-default holding full preset repairs cleanly without mutating smart-default label semantics.
  const db = getStudioDatabase();
  const corrupted = db.getSetting('studio.permissions.profiles.v1');
  corrupted.mainProfileId = DEFAULT_PERMISSION_PROFILE_IDS.smart;
  corrupted.profiles[DEFAULT_PERMISSION_PROFILE_IDS.smart].policy.preset = 'full';
  corrupted.profiles[DEFAULT_PERMISSION_PROFILE_IDS.smart].policy.default = 'allow';
  db.setSetting('studio.permissions.profiles.v1', corrupted);
  const repaired = getPermissionProfilesSnapshot(workspaceDir);
  assert.equal(repaired.mainProfileId, DEFAULT_PERMISSION_PROFILE_IDS.full);
  assert.equal(repaired.profiles.find((p) => p.id === DEFAULT_PERMISSION_PROFILE_IDS.smart).policy.preset, 'smart');
});

test('tool profile icons persist independently of tool selection and restore automatic appearance', () => {
  const id = MAIN_DEFAULT_PROFILE_ID;
  const icon = { shape: 'stagger', ink: 'berry' };
  const profile = () => getToolProfilesSnapshot().profiles.find(item => item.id === id);
  const before = profile();
  const selection = readAgentToolSelection();
  assert.equal(before.icon, null);
  saveToolProfile({ mode: 'edit', profile: { id, icon } });
  closeStudioDatabase();
  assert.deepEqual(profile(), { ...before, icon });
  assert.deepEqual(readAgentToolSelection(), selection);
  saveToolProfile({ mode: 'edit', profile: { id, name: before.name } });
  assert.deepEqual(profile().icon, icon);
  saveToolProfile({ mode: 'edit', profile: { id, icon: null } });
  assert.equal(profile().icon, null);
});

test('permission profile icons persist without overwriting bound workspace or session policies', t => {
  const id = 'profile-accent';
  const cwd = path.join(tmpRoot, 'icon-workspace');
  const sessionId = 'icon-workspace-session';
  const icon = { shape: 'ascending', ink: 'ocean' };
  const profile = () => getPermissionProfilesSnapshot(cwd).profiles.find(item => item.id === id);
  savePermissionProfile({ mode: 'create', profile: { id, name: '单独配色的方案', icon } });
  t.after(() => {
    deleteWorkspaceScopedSettings(cwd, [sessionId]);
    deletePermissionProfile({ cwd, id });
  });
  const before = profile();
  selectPermissionProfile({ cwd, id, scope: 'workspace' });
  setPermissionPolicy({ scope: 'workspace', cwd, policy: { ...before.policy, tools: { read: 'deny' } } });
  setPermissionPolicy({ scope: 'session', cwd, sessionId, policy: { ...before.policy, tools: { edit: 'deny' } } });
  const overrides = getPermissionPolicyStore();
  const nextIcon = { shape: 'inset' };
  savePermissionProfile({ cwd, mode: 'edit', profile: { id, icon: nextIcon } });
  closeStudioDatabase();
  assert.deepEqual(profile(), { ...before, icon: nextIcon });
  assert.deepEqual(getPermissionPolicyStore(), overrides);
  savePermissionProfile({ mode: 'edit', profile: { id, icon: { shape: '__proto__', ink: 'ocean' } } });
  assert.equal(profile().icon, null);
});

test('harness temporary profile selection and subagent profile tool/permission bindings persist', () => {
  const createdHarness = saveHarnessProfile({
    mode: 'create',
    profile: {
      id: 'temp-custom-harness',
      name: '临时轻量模板',
      customInstructions: 'Always answer in bullet points.',
      sections: { preamble: true, tools: true, rules: false, addendum: true },
      sectionOverrides: {},
      toolGuidance: {},
    },
  });
  assert.ok(createdHarness.profiles.some((p) => p.id === 'temp-custom-harness'));

  const selected = selectHarnessProfile({ id: 'temp-custom-harness', scope: 'temporary' });
  assert.equal(selected.temporaryProfileId, 'temp-custom-harness');
  assert.equal(getTemporaryHarnessProfile().id, 'temp-custom-harness');

  const afterDelete = deleteHarnessProfile({ id: 'temp-custom-harness' });
  assert.equal(afterDelete.temporaryProfileId, 'studio-temporary');
  assert.equal(getHarnessProfile('').id, afterDelete.globalProfileId);

  const savedRoles = saveSubagentProfile({
    avatarId: 'indigo-bob',
    name: '安全审查员',
    description: '执行只读审计',
    instructions: '只读取关键文件并输出发现',
    model: '',
    mcpServers: [],
    skills: [],
    harnessId: '',
    toolProfileId: MAIN_DEFAULT_PROFILE_ID,
    permissionProfileId: DEFAULT_PERMISSION_PROFILE_IDS.ask,
    runtimeOverrides: { allowedTools: 'read-only' },
  });
  const role = savedRoles.find((item) => item.name === '安全审查员');
  assert.ok(role);
  assert.equal(role.toolProfileId, MAIN_DEFAULT_PROFILE_ID);
  assert.equal(role.permissionProfileId, DEFAULT_PERMISSION_PROFILE_IDS.ask);
  assert.equal(
    listSubagentProfiles().find((item) => item.id === role.id)?.permissionProfileId,
    DEFAULT_PERMISSION_PROFILE_IDS.ask,
  );
  removeSubagentProfile({ id: role.id, revision: role.revision });
});
