const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-resources-'));
process.env.PI_STUDIO_USER_DATA = path.join(temporary, 'user-data');
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');
process.env.HOME = path.join(temporary, 'home');

const {
  closeStudioDatabase,
} = require('../../electron/core/studio-db.cjs');
const {
  directoryFingerprint,
  discoverSkills,
  expandSkillCommand,
  importSkill,
  parseFrontmatter,
  setSkillTrusted,
  sharedUserSkillsDirectory,
  skillInstructions,
} = require('../../electron/services/studio-skills.cjs');
const {
  DEFAULT_AGENT_TOOLS,
  matches,
  normalizeSelection,
  readAgentToolSelection,
} = require('../../electron/services/tool-selection.cjs');
const {
  mcpSnapshot,
  reloadMcpServers,
  toolExposureFor,
  toolName,
  __test: mcpTest,
} = require('../../electron/services/mcp-runtime.cjs');

after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function writeSkill(directory, {
  name,
  description,
  body = '# Instructions\n',
  disableModelInvocation = false,
} = {}) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    ...(disableModelInvocation ? ['disable-model-invocation: true'] : []),
    '---',
    '',
    body,
  ].join('\n'));
  return path.join(directory, 'SKILL.md');
}

test('Skill prompt exposes routing metadata without the instruction body', () => {
  const workspace = path.join(temporary, 'workspace-prompt');
  fs.mkdirSync(workspace, { recursive: true });
  writeSkill(path.join(process.env.PI_STUDIO_USER_DATA, 'skills', 'pdf-tools'), {
    name: 'pdf-tools',
    description: 'Extract PDF tables & citations.',
    body: 'PRIVATE_SKILL_BODY',
  });

  const prompt = skillInstructions(workspace, ['read']);
  assert.match(prompt, /<name>pdf-tools<\/name>/);
  assert.match(prompt, /Extract PDF tables &amp; citations\./);
  assert.match(prompt, /SKILL\.md/);
  assert.doesNotMatch(prompt, /PRIVATE_SKILL_BODY/);
});

test('Skill discovery follows the request file-reader capability', () => {
  const workspace = path.join(temporary, 'workspace-reader');
  fs.mkdirSync(workspace, { recursive: true });

  assert.equal(skillInstructions(workspace, []), undefined);
  assert.match(skillInstructions(workspace, ['bash']), /Use bash to read/);
  assert.match(skillInstructions(workspace, ['read']), /Use the read tool/);
});

test('project skills stay hidden until their complete directory fingerprint is trusted', () => {
  const workspace = path.join(temporary, 'workspace-trust');
  const skillFile = writeSkill(path.join(
    workspace,
    '.pi-studio',
    'skills',
    'review-project',
  ), {
    name: 'review-project',
    description: 'Review this repository.',
    body: 'PROJECT_BODY',
  });

  let skill = discoverSkills(workspace).skills.find((item) => item.name === 'review-project');
  assert.equal(skill.available, false);
  assert.equal(skill.trusted, false);
  assert.doesNotMatch(skillInstructions(workspace, ['read']) || '', /review-project/);

  setSkillTrusted(skillFile, workspace, true);
  skill = discoverSkills(workspace).skills.find((item) => item.name === 'review-project');
  assert.equal(skill.available, true);
  assert.match(skillInstructions(workspace, ['read']), /review-project/);

  fs.writeFileSync(path.join(path.dirname(skillFile), '.hidden-note'), 'changed');
  skill = discoverSkills(workspace).skills.find((item) => item.name === 'review-project');
  assert.equal(skill.available, false);
  assert.equal(skill.trustChanged, true);
  assert.doesNotMatch(skillInstructions(workspace, ['read']) || '', /review-project/);
});

test('project skills override user skills and shared .agents/skills can be trusted', () => {
  const workspace = path.join(temporary, 'workspace-precedence');
  fs.mkdirSync(workspace, { recursive: true });
  writeSkill(path.join(process.env.PI_STUDIO_USER_DATA, 'skills', 'review-order'), {
    name: 'review-order',
    description: 'USER_SKILL_DESCRIPTION',
  });
  const projectSkillFile = writeSkill(path.join(
    workspace,
    '.agents',
    'skills',
    'review-order',
  ), {
    name: 'review-order',
    description: 'PROJECT_SKILL_DESCRIPTION',
  });

  let discovered = discoverSkills(workspace);
  let selected = discovered.skills.find((item) => item.name === 'review-order');
  assert.equal(selected.scope, 'project');
  assert.equal(selected.origin, 'agents');
  assert.equal(selected.description, 'PROJECT_SKILL_DESCRIPTION');
  assert.match(
    discovered.errors.map((item) => item.message).join('\n'),
    /技能名「review-order」.*冲突/,
  );

  setSkillTrusted(projectSkillFile, workspace, true);
  discovered = discoverSkills(workspace);
  selected = discovered.skills.find((item) => item.name === 'review-order');
  assert.equal(selected.available, true);
  assert.match(skillInstructions(workspace, ['read']), /PROJECT_SKILL_DESCRIPTION/);
});

test('project skill roots take precedence over shared project and user skills', () => {
  const workspace = path.join(temporary, 'workspace-skill-precedence-chain');
  fs.mkdirSync(workspace, { recursive: true });
  const nativeFile = writeSkill(path.join(
    workspace,
    '.pi-studio',
    'skills',
    'precedence-chain',
  ), {
    name: 'precedence-chain',
    description: 'NATIVE_PROJECT_DESCRIPTION',
  });
  const sharedProjectFile = writeSkill(path.join(
    workspace,
    '.agents',
    'skills',
    'precedence-chain',
  ), {
    name: 'precedence-chain',
    description: 'SHARED_PROJECT_DESCRIPTION',
  });
  writeSkill(path.join(
    sharedUserSkillsDirectory(),
    'precedence-chain',
  ), {
    name: 'precedence-chain',
    description: 'SHARED_USER_DESCRIPTION',
  });

  setSkillTrusted(nativeFile, workspace, true);
  let selected = discoverSkills(workspace).skills
    .find((skill) => skill.name === 'precedence-chain');
  assert.equal(selected.scope, 'project');
  assert.equal(selected.origin, 'studio');
  assert.match(skillInstructions(workspace, ['read']), /NATIVE_PROJECT_DESCRIPTION/);

  fs.rmSync(path.dirname(nativeFile), { recursive: true, force: true });
  setSkillTrusted(sharedProjectFile, workspace, true);
  selected = discoverSkills(workspace).skills
    .find((skill) => skill.name === 'precedence-chain');
  assert.equal(selected.scope, 'project');
  assert.equal(selected.origin, 'agents');
  assert.match(skillInstructions(workspace, ['read']), /SHARED_PROJECT_DESCRIPTION/);

  fs.rmSync(path.dirname(sharedProjectFile), { recursive: true, force: true });
  selected = discoverSkills(workspace).skills
    .find((skill) => skill.name === 'precedence-chain');
  assert.equal(selected.scope, 'user');
  assert.equal(selected.origin, 'agents');
  assert.match(skillInstructions(workspace, ['read']), /SHARED_USER_DESCRIPTION/);
});

test('re-trusting an edited project skill updates routing metadata immediately', () => {
  const workspace = path.join(temporary, 'workspace-skill-hot-reload');
  const skillFile = writeSkill(path.join(
    workspace,
    '.pi-studio',
    'skills',
    'hot-reload',
  ), {
    name: 'hot-reload',
    description: 'OLD_SKILL_DESCRIPTION',
  });
  setSkillTrusted(skillFile, workspace, true);
  assert.match(skillInstructions(workspace, ['read']), /OLD_SKILL_DESCRIPTION/);

  writeSkill(path.dirname(skillFile), {
    name: 'hot-reload',
    description: 'NEW_SKILL_DESCRIPTION',
  });
  let selected = discoverSkills(workspace).skills.find((skill) => skill.name === 'hot-reload');
  assert.equal(selected.available, false);
  assert.equal(selected.trustChanged, true);

  setSkillTrusted(skillFile, workspace, true);
  selected = discoverSkills(workspace).skills.find((skill) => skill.name === 'hot-reload');
  assert.equal(selected.available, true);
  const prompt = skillInstructions(workspace, ['read']);
  assert.match(prompt, /NEW_SKILL_DESCRIPTION/);
  assert.doesNotMatch(prompt, /OLD_SKILL_DESCRIPTION/);
});

test('skill metadata follows the Agent Skills name and optional field rules', () => {
  const workspace = path.join(temporary, 'workspace-skill-metadata');
  const skillDirectory = path.join(
    process.env.PI_STUDIO_USER_DATA,
    'skills',
    'directory-name',
  );
  fs.mkdirSync(skillDirectory, { recursive: true });
  fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), [
    '---',
    'name: different-name',
    'description: Metadata validation fixture.',
    'compatibility: 123',
    'metadata:',
    '  version: 1',
    'allowed-tools:',
    '  - Read',
    '---',
    'Body',
  ].join('\n'));

  const skill = discoverSkills(workspace).skills.find((item) => item.name === 'different-name');
  assert.ok(skill);
  assert.match(skill.warnings.join('\n'), /必须与技能目录名「directory-name」一致/);
  assert.match(skill.warnings.join('\n'), /compatibility/);
  assert.match(skill.warnings.join('\n'), /metadata/);
  assert.match(skill.warnings.join('\n'), /allowed-tools/);
});

test('explicit skill commands work while automatic invocation remains disabled', () => {
  const workspace = path.join(temporary, 'workspace-explicit');
  fs.mkdirSync(workspace, { recursive: true });
  writeSkill(path.join(process.env.PI_STUDIO_USER_DATA, 'skills', 'explicit-only'), {
    name: 'explicit-only',
    description: 'Only run when selected explicitly.',
    body: 'EXPLICIT_BODY',
    disableModelInvocation: true,
  });

  const automatic = skillInstructions(workspace, ['read']);
  if (automatic) assert.doesNotMatch(automatic, /explicit-only/);
  const expanded = expandSkillCommand('/skill:explicit-only focus security', workspace);
  assert.match(expanded, /EXPLICIT_BODY/);
  assert.match(expanded, /focus security$/);
});

test('project skill discovery rejects symlinks that escape the workspace', () => {
  const workspace = path.join(temporary, 'workspace-root-symlink');
  const external = path.join(temporary, 'external-skills');
  fs.mkdirSync(path.join(workspace, '.pi-studio'), { recursive: true });
  writeSkill(path.join(external, 'escaped'), {
    name: 'escaped',
    description: 'Must not load.',
  });
  fs.symlinkSync(external, path.join(workspace, '.pi-studio', 'skills'), 'dir');

  const discovered = discoverSkills(workspace);
  assert.equal(discovered.skills.some((item) => item.name === 'escaped'), false);
  assert.match(
    discovered.errors.map((item) => item.message).join('\n'),
    /符号链接越出工作区/,
  );
});

test('project import validates the source graph before copying', () => {
  const source = path.join(temporary, 'skill-import-source');
  const outside = path.join(temporary, 'outside-skill-data.txt');
  fs.writeFileSync(outside, 'outside');
  writeSkill(source, {
    name: 'unsafe-import',
    description: 'Has an escaping link.',
  });
  fs.symlinkSync(outside, path.join(source, 'outside-link'));

  assert.throws(
    () => importSkill(source, 'project', path.join(temporary, 'workspace-import')),
    /指向外部的符号链接/,
  );
});

test('frontmatter parsing handles BOM, CRLF, and indented block scalars', () => {
  const parsed = parseFrontmatter(
    '\uFEFF---\r\nname: demo\r\ndescription: >-\r\n    First line\r\n    second line\r\n---\r\n\r\nBody',
  );
  assert.equal(parsed.fields.name, 'demo');
  assert.equal(parsed.fields.description, 'First line second line');
  assert.equal(parsed.body.trim(), 'Body');
});

test('frontmatter uses YAML semantics and rejects malformed documents', () => {
  const parsed = parseFrontmatter([
    '---',
    'name: yaml-skill',
    'description: "Quoted: description"',
    'disable-model-invocation: true',
    'metadata:',
    '  owner: pi-studio',
    '---',
    'Body',
  ].join('\n'));
  assert.equal(parsed.fields.description, 'Quoted: description');
  assert.equal(parsed.fields['disable-model-invocation'], true);
  assert.deepEqual(parsed.fields.metadata, { owner: 'pi-studio' });

  assert.throws(
    () => parseFrontmatter('---\nname: broken\ndescription: [unterminated\n---\nBody'),
    /YAMLParseError/i,
  );
});

test('directory fingerprints include hidden files and reject escaping symlinks', () => {
  const directory = path.join(temporary, 'fingerprint-skill');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, '.hidden'), 'one');
  const before = directoryFingerprint(directory);
  fs.writeFileSync(path.join(directory, '.hidden'), 'two');
  assert.notEqual(directoryFingerprint(directory), before);

  const outside = path.join(temporary, 'fingerprint-outside');
  fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, path.join(directory, 'outside-link'));
  assert.throws(() => directoryFingerprint(directory), /指向外部的符号链接/);
});

test('MCP names are provider-safe and deterministic under collisions', () => {
  assert.equal(toolName('docs-server', 'read page'), 'mcp__docs_server__read_page');
  const collided = toolName('docs-server', 'read page', () => true);
  assert.ok(collided.length <= 64);
  assert.notEqual(collided, 'mcp__docs_server__read_page');
  assert.match(collided, /_[a-f0-9]{8}$/);

  const exposure = {
    exposure: 'deferred',
    toolExposure: {
      'get_*': 'direct',
      get_one: 'hidden',
    },
  };
  assert.equal(toolExposureFor(exposure, 'get_one'), 'hidden');
  assert.equal(toolExposureFor(exposure, 'get_two'), 'direct');
  assert.equal(toolExposureFor(exposure, 'delete_one'), 'deferred');
});

test('MCP connection signatures include the configured working directory', () => {
  const base = {
    transport: 'stdio',
    command: 'node',
    args: ['server.mjs'],
    cwd: '/tmp/one',
    url: '',
    env: {},
    headers: {},
    timeoutSeconds: 60,
  };
  assert.notEqual(
    mcpTest.connectionSignature(base),
    mcpTest.connectionSignature({ ...base, cwd: '/tmp/two' }),
  );
});

test('MCP client and transport cleanup remain bounded when either or both hang', async () => {
  for (const hanging of [
    { client: true, transport: false },
    { client: false, transport: true },
    { client: true, transport: true },
  ]) {
    let clientCloses = 0;
    let transportCloses = 0;
    const startedAt = Date.now();
    await mcpTest.closeClientResources({
      close() {
        clientCloses += 1;
        return hanging.client ? new Promise(() => {}) : Promise.resolve();
      },
    }, {
      close() {
        transportCloses += 1;
        return hanging.transport ? new Promise(() => {}) : Promise.resolve();
      },
    }, { closeTimeoutMs: 20 });
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(clientCloses, 1);
    assert.equal(transportCloses, 1);
  }
});

test('concurrent MCP entry closes share one cleanup promise', async () => {
  let releaseClient;
  let clientCloses = 0;
  let transportCloses = 0;
  const clientGate = new Promise((resolve) => {
    releaseClient = resolve;
  });
  const entry = {
    client: {
      async close() {
        clientCloses += 1;
        await clientGate;
      },
    },
    transport: {
      async close() {
        transportCloses += 1;
      },
    },
    closing: false,
    closed: false,
  };

  const first = mcpTest.closeEntry(entry);
  const second = mcpTest.closeEntry(entry);
  assert.equal(first, second);
  assert.equal(entry.closing, true);
  assert.equal(entry.closed, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clientCloses, 1);
  assert.equal(transportCloses, 1);

  releaseClient();
  await Promise.all([first, second]);
  assert.equal(clientCloses, 1);
  assert.equal(transportCloses, 1);
});

test('MCP state disposal is idempotent and clears every entry timer', async () => {
  let refreshFired = false;
  let entryReconnectFired = false;
  let stateReconnectFired = false;
  let releaseClient;
  let clientCloses = 0;
  const clientGate = new Promise((resolve) => {
    releaseClient = resolve;
  });
  const refreshTimer = setTimeout(() => { refreshFired = true; }, 40);
  const entryReconnectTimer = setTimeout(() => { entryReconnectFired = true; }, 40);
  const stateReconnectTimer = setTimeout(() => { stateReconnectFired = true; }, 40);
  const entry = {
    client: {
      async close() {
        clientCloses += 1;
        await clientGate;
      },
    },
    transport: { close: async () => {} },
    refreshTimer,
    reconnectTimer: entryReconnectTimer,
    closing: false,
    closed: false,
  };
  const uninstalled = [];
  const extension = { name: 'studio-mcp:docs' };
  const catalog = { name: 'studio-mcp-catalog' };
  const current = {
    runtime: {
      registry: {
        uninstall(value) {
          uninstalled.push(value);
        },
      },
    },
    entries: new Map([['docs', entry]]),
    extensions: new Map([['docs', extension]]),
    catalogExtension: catalog,
    reconnectTimers: new Map([['docs', stateReconnectTimer]]),
    retiredEntries: new Set(),
    closingEntries: new Set(),
    closing: false,
    closePromise: undefined,
  };

  const first = mcpTest.disposeMcpState(current);
  const second = mcpTest.disposeMcpState(current);
  assert.equal(first, second);
  assert.equal(current.closing, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clientCloses, 1);
  assert.deepEqual(uninstalled, [extension, catalog]);

  releaseClient();
  await Promise.all([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(refreshFired, false);
  assert.equal(entryReconnectFired, false);
  assert.equal(stateReconnectFired, false);
  assert.equal(current.entries.size, 0);
  assert.equal(current.reconnectTimers.size, 0);
});

test('an MCP disconnect cannot rebuild or reconnect after runtime shutdown starts', async () => {
  const runtime = { registry: { uninstall() {} } };
  await reloadMcpServers(runtime);
  const current = mcpTest.currentState();
  assert.ok(current);

  let onClose;
  const client = {
    onNotification() {},
    onError() {},
    onClose(listener) {
      onClose = listener;
    },
    close: async () => {},
  };
  const entry = {
    server: {
      name: 'late-disconnect',
      timeoutSeconds: 1,
    },
    client,
    transport: { close: async () => {} },
    tools: [],
    instructions: '',
    registeredTools: [],
    activeCalls: 0,
    closing: false,
    closed: false,
    retired: false,
    retiredSet: undefined,
    refreshTimer: undefined,
    reconnectTimer: undefined,
  };
  current.entries.set('late-disconnect', entry);
  mcpTest.watchClient(current, runtime, 'late-disconnect', client, {});
  mcpTest.scheduleReconnect(current, runtime, 'late-disconnect');
  assert.equal(current.reconnectTimers.size, 1);

  onClose();
  await mcpTest.disposeMcpState(current);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(current.reconnectTimers.size, 0);
  assert.equal(mcpTest.currentState(), undefined);
  assert.equal(mcpSnapshot().refreshedAt, 0);
});

test('a changed MCP client stays alive until its active tool call finishes', async () => {
  let resolveCall;
  let closeCount = 0;
  const pendingCall = new Promise((resolve) => {
    resolveCall = resolve;
  });
  const entry = {
    server: {
      name: 'docs',
      description: '',
      timeoutSeconds: 60,
    },
    client: {
      callTool: () => pendingCall,
      close: async () => {
        closeCount += 1;
      },
    },
    activeCalls: 0,
    closing: false,
    closed: false,
    retired: false,
    retiredSet: undefined,
  };
  const durable = {
    defineTool: (definition) => definition,
  };
  const piAi = {
    Type: {
      Unsafe: (schema) => schema,
    },
  };
  const Mcp = {
    toLlmContent: () => [{ type: 'text', text: 'ok' }],
  };
  const tool = mcpTest.mcpToolRegistration(
    entry,
    {
      name: 'search',
      description: 'Search docs.',
      inputSchema: { type: 'object', properties: {} },
    },
    'mcp__docs__search',
    'deferred',
    durable,
    piAi,
    Mcp,
  );
  const running = tool.execute({}, {}, {});
  assert.equal(entry.activeCalls, 1);

  const current = { retiredEntries: new Set() };
  await mcpTest.retireEntry(current, entry);
  assert.equal(entry.closing, true);
  assert.equal(closeCount, 0);
  assert.equal(current.retiredEntries.has(entry), true);

  resolveCall({
    content: [{ type: 'text', text: 'result' }],
    isError: false,
  });
  await running;
  assert.equal(closeCount, 1);
  assert.equal(current.retiredEntries.has(entry), false);
});

test('MCP text output is bounded by UTF-8 bytes and preserves both ends', async () => {
  const text = `START-${'鲸'.repeat(12_000)}-END`;
  const result = await mcpTest.boundedMcpOutput([{ type: 'text', text }]);
  const bounded = result.content.find((block) => block.type === 'text').text;
  assert.ok(Buffer.byteLength(bounded) <= 20 * 1024);
  assert.match(bounded, /^START-/);
  assert.match(bounded, /-END$/);
  assert.match(bounded, /bytes truncated/);
  assert.ok(result.fullOutputPath);
  assert.equal(fs.readFileSync(result.fullOutputPath, 'utf8'), text);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(result.fullOutputPath).mode & 0o777, 0o600);
  }
  fs.rmSync(result.fullOutputPath, { force: true });
});

test('MCP stderr diagnostics are bounded and redact configured secrets', () => {
  const secret = 'studio-secret-token';
  const transport = {
    stderr: `${'log line\n'.repeat(1_500)}server printed ${secret}\nlast line`,
  };
  const diagnostic = mcpTest.diagnosticTail(transport, {}, [secret]);
  assert.ok(Buffer.byteLength(diagnostic) <= 8 * 1024);
  assert.doesNotMatch(diagnostic, new RegExp(secret));
  assert.match(diagnostic, /\[redacted\]/);
  assert.match(diagnostic, /last line$/);

  const failure = mcpTest.failureWithDiagnostics(
    new Error('connection failed'),
    transport,
    {},
    [secret],
  );
  assert.match(failure.message, /connection failed/);
  assert.match(failure.message, /stderr:/);
  assert.doesNotMatch(failure.message, new RegExp(secret));
});

test('Agent tool wildcards select MCP namespaces and legacy selections gain MCP access', () => {
  assert.equal(matches('mcp__*', 'mcp__docs__search'), true);
  assert.equal(matches('mcp__docs__*', 'mcp__docs__search'), true);
  assert.equal(matches('mcp__docs__*', 'mcp__github__search'), false);
  assert.equal(DEFAULT_AGENT_TOOLS.includes('mcp__*'), true);
  assert.deepEqual(normalizeSelection(['read', 'read', 'mcp__*']).enabled, ['read', 'mcp__*']);

  const values = new Map([
    ['studio.agent.tools', ['read', 'write']],
    ['studio.agent.tools.version', 1],
  ]);
  const db = {
    getSetting(key, fallback) {
      return values.has(key) ? values.get(key) : fallback;
    },
    setSetting(key, value) {
      values.set(key, value);
      return value;
    },
  };
  const selection = readAgentToolSelection(db);
  assert.equal(selection.enabled.includes('mcp__*'), true);
  assert.equal(values.get('studio.agent.tools.version'), 2);
});
