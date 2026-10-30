const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRegistry } = require('@earendil-works/pi-durable');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');

installElectronSafeStorage({ after });

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-mcp-reload-'));
process.env.PI_STUDIO_USER_DATA = path.join(temporary, 'user-data');
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');
process.env.PI_STUDIO_MCP_LEAK_FIXTURE = 'must-not-reach-child';

const {
  closeStudioDatabase,
  getStudioDatabase,
} = require('../../electron/core/studio-db.cjs');
const {
  __test,
  closeMcpRuntime,
  mcpSnapshot,
  reloadMcpServers,
  toolName,
} = require('../../electron/services/mcp-runtime.cjs');

const serverFile = path.join(temporary, 'mcp-server.mjs');
fs.writeFileSync(serverFile, String.raw`
import readline from 'node:readline';

let listCount = 0;
let announced = false;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'reload-fixture', version: '1.0.0' },
        instructions: 'MCP reload fixture.',
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    listCount += 1;
    const name = listCount === 1 ? 'old_tool' : 'new_tool';
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name,
          description: name + ' description',
          inputSchema: { type: 'object', properties: {} },
        }],
      },
    });
    if (!announced) {
      announced = true;
      setTimeout(() => send({
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed',
        params: {},
      }), 300).unref();
    }
    return;
  }
  if (message.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: 'Method not found' },
    });
  }
});

process.stderr.write('fixture token ' + (process.env.TOKEN || '') + '\n');
process.stderr.write('fixture private env ' + (process.env.PI_STUDIO_MCP_LEAK_FIXTURE || 'missing') + '\n');
input.on('close', () => process.exit(0));
`);

getStudioDatabase().upsertMcpServer({
  name: 'reload',
  transport: 'stdio',
  command: process.execPath,
  args: [serverFile],
  cwd: temporary,
  url: '',
  description: 'Runtime reload fixture',
  env: { TOKEN: 'mcp-reload-secret' },
  headers: {},
  exposure: 'deferred',
  toolExposure: {},
  timeoutSeconds: 5,
  enabled: true,
});

after(async () => {
  await closeMcpRuntime();
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function deferredNames() {
  return mcpSnapshot().tools
    .filter((tool) => tool.exposure === 'deferred')
    .map((tool) => tool.name);
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function within(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test('MCP tools/list_changed refreshes only the connected catalog and clears stale errors', async () => {
  const runtime = { registry: createRegistry() };
  await reloadMcpServers(runtime);

  assert.deepEqual(deferredNames(), [
    toolName('reload', 'old_tool'),
  ]);
  await waitFor(
    () => deferredNames().includes(toolName('reload', 'new_tool')),
    'the changed MCP tool catalog',
  );
  assert.deepEqual(deferredNames(), [
    toolName('reload', 'new_tool'),
  ]);
  assert.deepEqual(mcpSnapshot().errors, []);

  const server = mcpSnapshot().servers.find((item) => item.name === 'reload');
  assert.match(server.stderr, /fixture token/);
  assert.doesNotMatch(server.stderr, /mcp-reload-secret/);
  assert.match(server.stderr, /\[redacted\]/);
  assert.doesNotMatch(server.stderr, /must-not-reach-child/);
  assert.match(server.stderr, /fixture private env missing/);
});

test('MCP child environments inherit runtime essentials and only explicit configuration', () => {
  const keys = [
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'COMMONPROGRAMFILES',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = `fixture-${key}`;
    const inherited = __test.mcpClientEnvironment({ TOKEN: 'configured' });
    assert.equal(inherited.TOKEN, 'configured');
    assert.equal(inherited.PI_STUDIO_MCP_LEAK_FIXTURE, undefined);
    if (process.env.PATH) assert.equal(inherited.PATH, process.env.PATH);
    for (const key of keys) assert.equal(inherited[key], `fixture-${key}`);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('runtime reload rejects legacy insecure MCP URLs without blocking healthy servers', async () => {
  const db = getStudioDatabase();
  db.upsertMcpServer({
    name: 'unsafe-legacy',
    transport: 'http',
    command: '',
    args: [],
    cwd: temporary,
    url: 'http://example.com/mcp',
    description: 'legacy invalid URL',
    env: {},
    headers: {},
    exposure: 'deferred',
    toolExposure: {},
    timeoutSeconds: 5,
    enabled: true,
  });
  try {
    await reloadMcpServers({ registry: createRegistry() });
    const snapshot = mcpSnapshot();
    const failure = snapshot.errors.find((item) => item.server === 'unsafe-legacy');
    assert.match(failure?.message || '', /必须使用 HTTPS/);
    assert.equal(
      snapshot.tools.some((tool) => tool.server === 'reload'),
      true,
      'the valid stdio server must remain available',
    );
    assert.equal(
      snapshot.servers.some((server) => server.name === 'unsafe-legacy'),
      false,
    );
  } finally {
    db.removeMcpServer('unsafe-legacy');
    await reloadMcpServers({ registry: createRegistry() });
  }
});

test('runtime handoff disposes the old MCP clients without deadlocking the reload queue', async () => {
  const previous = { registry: createRegistry() };
  const next = { registry: createRegistry() };

  await reloadMcpServers(previous);
  const snapshot = await within(
    reloadMcpServers(next),
    5_000,
    'MCP runtime handoff',
  );

  assert.deepEqual(snapshot.tools.map((tool) => tool.name), [
    toolName('reload', 'old_tool'),
  ]);
  assert.equal(
    previous.registry.snapshot().tools().some(({ extension }) => (
      extension.name.startsWith('studio-mcp:')
    )),
    false,
  );
  assert.equal(
    next.registry.snapshot().tools().some(({ tool }) => (
      tool.name === toolName('reload', 'old_tool')
    )),
    true,
  );
});
