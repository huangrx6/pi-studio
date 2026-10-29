const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-harness-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');
const userData = path.join(temporary, 'user-data');
const globalInstructionsPath = path.join(userData, 'AGENTS.md');
process.env.PI_STUDIO_USER_DATA = userData;
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(globalInstructionsPath, 'global rule');

const {
  DEFAULT_HARNESS_SECTIONS,
  RUNTIME_POLICY_DEFAULTS,
  deleteHarnessProfile,
  getHarnessProfile,
  getRuntimePolicy,
  normalizeHarnessProfile,
  normalizeHarnessStore,
  normalizeRuntimePolicy,
  normalizeSectionOverrides,
  saveHarnessProfile,
  saveRuntimePolicy,
  selectHarnessProfile,
  normalizeToolGuidance,
  resetHarnessProfile,
} = require('../../electron/core/app-settings.cjs');
const { closeStudioDatabase } = require('../../electron/core/studio-db.cjs');
const {
  createStudioHarnessExtension,
  globalInstructionFile,
  projectContext,
  projectInstructionFiles,
  projectRoot,
  sectionOverride,
  toolGuidance,
} = require('../../electron/services/studio-harness.cjs');
const {
  durableHarnessSettings,
} = require('../../electron/services/durable-runtime.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('the default harness profile enables every baseline section', () => {
  assert.deepEqual(DEFAULT_HARNESS_SECTIONS, {
    preamble: true,
    tools: true,
    rules: true,
    repositoryDocs: true,
    projectContext: true,
    skills: true,
    cwd: true,
    addendum: true,
  });
  const profile = getHarnessProfile();
  assert.equal(profile.id, 'studio-coding');
  assert.equal(profile.builtin, true);
  assert.deepEqual(profile.sections, DEFAULT_HARNESS_SECTIONS);
});

test('custom profiles persist, validate section switches, and can be workspace scoped', () => {
  const workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(workspace);
  const saved = saveHarnessProfile({
    profile: {
      id: 'review-first',
      name: 'Review first',
      sections: {
        tools: false,
        addendum: true,
        unknownSection: false,
      },
      customInstructions: 'Inspect twice before editing.',
      toolGuidance: {
        bash: 'Run the project test command before changing production code.',
      },
    },
  });
  assert.equal(saved.profiles.some((profile) => profile.id === 'review-first'), true);
  const selected = selectHarnessProfile({ id: 'review-first', cwd: workspace });
  assert.equal(selected.activeProfileId, 'review-first');
  assert.equal(selected.workspaceProfileId, 'review-first');
  const profile = getHarnessProfile(workspace);
  assert.equal(profile.sections.preamble, true);
  assert.equal(profile.sections.tools, false);
  assert.equal(Object.hasOwn(profile.sections, 'unknownSection'), false);
  assert.equal(
    profile.toolGuidance.bash,
    'Run the project test command before changing production code.',
  );
  assert.equal(getHarnessProfile().id, 'studio-coding');
  const inherited = selectHarnessProfile({ cwd: workspace, scope: 'inherit', id: 'review-first' });
  assert.equal(inherited.workspaceProfileId, '');
  assert.equal(inherited.activeProfileId, inherited.globalProfileId);
});

test('profiles are versioned and prototype-sensitive ids are rejected', () => {
  const normalized = normalizeHarnessStore({
    activeProfileId: 'constructor',
    profiles: {
      'review-first': { id: 'review-first', sections: { rules: false } },
      constructor: { id: 'constructor' },
    },
  });
  assert.equal(normalized.version, 1);
  assert.equal(normalized.activeProfileId, 'studio-coding');
  assert.equal(Object.hasOwn(normalized.profiles, 'constructor'), false);
  assert.equal(normalized.profiles['review-first'].sections.rules, false);
  assert.equal(normalizeHarnessProfile({ id: '_invalid' }).id, 'studio-coding');
  assert.throws(
    () => saveHarnessProfile({ profile: { id: '_invalid' } }),
    /profile id/,
  );
});

test('custom profiles can be reset and deleted without losing the default baseline', () => {
  saveHarnessProfile({
    profile: {
      id: 'temporary-profile',
      name: 'Temporary',
      sections: { rules: false },
      customInstructions: 'temporary only',
    },
  });
  const reset = resetHarnessProfile({ id: 'temporary-profile' });
  const profile = reset.profiles.find((item) => item.id === 'temporary-profile');
  assert.equal(profile.name, 'Temporary');
  assert.equal(profile.sections.rules, true);
  assert.equal(profile.customInstructions, '');
  const deleted = deleteHarnessProfile({ id: 'temporary-profile' });
  assert.equal(deleted.profiles.some((item) => item.id === 'temporary-profile'), false);
  assert.throws(() => deleteHarnessProfile({ id: 'studio-coding' }), /不能删除/);
});

test('runtime policy normalizes nested Durable settings and clamps unsafe values', () => {
  const normalized = normalizeRuntimePolicy({
    streamTimeoutMs: -5,
    retry: {
      enabled: false,
      maxRetries: 99,
      baseDelayMs: 1,
    },
    compaction: {
      enabled: false,
      reserveTokens: 1,
      keepRecentTokens: -20,
      backgroundTokens: 999_999,
    },
    toolExecution: 'parallel',
    afterFailedRun: 'continue',
    restartLimit: 0,
    contextRetentionMs: 0,
    documentRetentionMs: 9_999_999,
  });
  assert.equal(normalized.streamTimeoutMs, 0);
  assert.deepEqual(normalized.retry, {
    enabled: false,
    maxRetries: 10,
    baseDelayMs: 100,
  });
  assert.deepEqual(normalized.compaction, {
    enabled: false,
    reserveTokens: 1_024,
    keepRecentTokens: 0,
    backgroundTokens: 262_144,
  });
  assert.equal(normalized.toolExecution, 'parallel');
  assert.equal(normalized.afterFailedRun, 'continue');
  assert.equal(normalized.restartLimit, 1);
  assert.equal(normalized.contextRetentionMs, 0);
  assert.equal(normalized.documentRetentionMs, 3_600_000);
  assert.equal(normalizeRuntimePolicy({ toolExecution: 'race' }).toolExecution, 'parallel');
  assert.equal(normalizeRuntimePolicy({ afterFailedRun: 'retry' }).afterFailedRun, 'keep');
});

test('runtime policy persists in SQLite and is included in Harness snapshots', () => {
  const before = getRuntimePolicy();
  assert.equal(before.retry.maxRetries, RUNTIME_POLICY_DEFAULTS.retry.maxRetries);
  saveRuntimePolicy({
    ...before,
    toolExecution: 'sequential',
    retry: { ...before.retry, maxRetries: 1 },
    compaction: { ...before.compaction, backgroundTokens: 0 },
  });
  const after = getRuntimePolicy();
  assert.equal(after.toolExecution, 'sequential');
  assert.equal(after.retry.maxRetries, 1);
  assert.equal(after.compaction.backgroundTokens, 0);
  const snapshot = require('../../electron/core/app-settings.cjs').getHarnessSettings();
  assert.deepEqual(snapshot.runtimePolicy, after);
  assert.deepEqual(snapshot.runtimePolicyDefaults, RUNTIME_POLICY_DEFAULTS);
  assert.match(snapshot.runtimePolicyPath, /studio\.runtime\.policy/);
  const durableSettings = durableHarnessSettings();
  assert.equal(durableSettings.toolExecution, 'sequential');
  assert.equal(durableSettings.retry.maxRetries, 1);
  assert.equal(durableSettings.compaction.backgroundTokens, 0);
  assert.equal(durableSettings.contextRetentionMs, after.contextRetentionMs);
});

test('Harness snapshots expose the global instruction path and status', () => {
  const snapshot = require('../../electron/core/app-settings.cjs').getHarnessSettings();
  assert.equal(globalInstructionFile(), globalInstructionsPath);
  assert.equal(snapshot.globalInstructionsPath, globalInstructionsPath);
  assert.equal(snapshot.globalInstructionsStatus, 'present');
});

test('a profile can override one prompt section without replacing the Studio baseline', async () => {
  const saved = saveHarnessProfile({
    profile: {
      id: 'strict-review',
      name: 'Strict review',
      sectionOverrides: {
        preamble: 'You are a conservative reviewer.',
        cwd: '   ',
        unknown: 'must not persist',
      },
    },
  });
  const profile = saved.profiles.find((item) => item.id === 'strict-review');
  assert.deepEqual(profile.sectionOverrides, {
    preamble: 'You are a conservative reviewer.',
  });
  selectHarnessProfile({ id: 'strict-review', scope: 'global' });
  assert.equal(sectionOverride('', 'preamble'), 'You are a conservative reviewer.');
  assert.equal(sectionOverride('', 'rules'), undefined);

  const durable = {
    defineExtension: (value) => value,
    section: (key, render) => ({ key, render }),
  };
  const extension = createStudioHarnessExtension(durable);
  const preamble = extension.sections.find((section) => section.key === 'preamble');
  assert.equal(
    await preamble.render({ agent: { cwd: '', tools: [] } }, {}),
    'You are a conservative reviewer.',
  );
  const rules = extension.sections.find((section) => section.key === 'coding-rules');
  assert.match(await rules.render({ agent: { cwd: '', tools: [] } }, {}), /Engineering rules/);
  assert.deepEqual(normalizeSectionOverrides({
    rules: 'review twice',
    cwd: '',
    constructor: 'unsafe',
  }), { rules: 'review twice' });
  selectHarnessProfile({ id: 'studio-coding', scope: 'global' });
});

test('tool guidance reflects the tools actually offered to the model', () => {
  const guidance = toolGuidance({
    agent: {
      tools: [
        { name: 'read', description: 'Read a file.' },
        { name: 'edit', description: 'Replace an exact string.' },
      ],
    },
  });
  assert.match(guidance, /read: Read a file\. Inspect files/);
  assert.match(guidance, /edit: Replace an exact string\. Use the smallest unique replacement/);
  assert.match(guidance, /independent tool calls in the same round/);
  assert.doesNotMatch(guidance, /- bash:/);
  const overridden = toolGuidance({
    agent: { tools: [{ name: 'bash', description: 'Run a command.' }] },
  }, {
    toolGuidance: { bash: 'Prefer the repository test command.' },
  });
  assert.match(overridden, /Run a command\. Prefer the repository test command\./);
  assert.deepEqual(normalizeToolGuidance({
    bash: 'Run tests.',
    '__proto__': 'unsafe',
    empty: '   ',
  }), { bash: 'Run tests.' });
});

test('global instructions lead project files from the nearest project root to cwd', async () => {
  const root = path.join(temporary, 'project');
  const child = path.join(root, 'packages', 'app');
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: /fixture/worktree');
  fs.mkdirSync(path.join(root, '.pi-studio'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root rule');
  fs.writeFileSync(path.join(root, '.pi-studio', 'AGENTS.md'), 'root studio rule');
  fs.writeFileSync(path.join(child, 'AGENTS.md'), 'child rule');
  const result = await projectContext(child);
  assert.equal(await projectRoot(child), root);
  assert.ok(result.indexOf('global rule') < result.indexOf('root rule'));
  assert.ok(result.indexOf('root rule') < result.indexOf('root studio rule'));
  assert.ok(result.indexOf('root studio rule') < result.indexOf('child rule'));
  assert.match(result, /scope="global"/);
  assert.match(result, /scope="project"/);
});

test('project instruction discovery stops at the nearest project boundary', async () => {
  const outer = path.join(temporary, 'outer');
  const inner = path.join(outer, 'packages', 'inner');
  const cwd = path.join(inner, 'src');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(outer, '.git'), 'gitdir: /fixture/outer');
  fs.writeFileSync(path.join(outer, 'AGENTS.md'), 'outer rule');
  fs.mkdirSync(path.join(inner, '.pi-studio'));
  fs.writeFileSync(path.join(inner, 'AGENTS.md'), 'inner rule');

  const files = await projectInstructionFiles(cwd);
  assert.deepEqual(files.map((item) => item.body), ['inner rule']);
  const result = await projectContext(cwd);
  assert.ok(result.indexOf('global rule') < result.indexOf('inner rule'));
  assert.doesNotMatch(result, /outer rule/);
});

test('without a project marker only instructions at cwd are loaded', async () => {
  const parent = path.join(temporary, 'no-marker');
  const cwd = path.join(parent, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(parent, 'AGENTS.md'), 'ancestor rule');
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'workspace rule');

  const files = await projectInstructionFiles(cwd);
  assert.deepEqual(files.map((item) => item.body), ['workspace rule']);
});

test('disabled sections return no prompt text on the next render', async () => {
  saveHarnessProfile({
    profile: {
      id: 'minimal',
      name: 'Minimal',
      sections: { preamble: false },
    },
  });
  selectHarnessProfile({ id: 'minimal' });
  const durable = {
    defineExtension: (value) => value,
    section: (key, render) => ({ key, render }),
  };
  const extension = createStudioHarnessExtension(durable);
  const preamble = extension.sections.find((section) => section.key === 'preamble');
  assert.equal(await preamble.render({ agent: { cwd: '', tools: [] } }, {}), undefined);
  const rules = extension.sections.find((section) => section.key === 'coding-rules');
  assert.match(await rules.render({ agent: { cwd: '', tools: [] } }, {}), /Engineering rules/);
  saveHarnessProfile({
    profile: {
      id: 'minimal',
      name: 'Minimal',
      sections: { preamble: false },
      sectionOverrides: { preamble: 'This override must stay disabled.' },
    },
  });
  selectHarnessProfile({ id: 'minimal' });
  assert.equal(await preamble.render({ agent: { cwd: '', tools: [] } }, {}), undefined);
});
