const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  classifyOwnership,
  createRuntimeServiceScanner,
  descendantsOf,
  parseElapsedSeconds,
  parseLsofListeners,
  parseProcessTable,
  pathWithin,
  processIsAlive,
  redactCommand,
  selectRegisteredRoots,
  terminateProcess,
} = require('../../electron/services/runtime-services.cjs');

test('lsof listener parsing handles localhost, wildcard and IPv6 listeners', () => {
  const listeners = parseLsofListeners([
    'p100',
    'cnode',
    'f18',
    'PTCP',
    'n127.0.0.1:3000',
    'f19',
    'PTCP',
    'n[::1]:3001',
    'f20',
    'PTCP',
    'n127.0.0.1:4000',
    'f21',
    'PTCP',
    'n*:4000',
    'f22',
    'PTCP',
    'n*:4000',
  ].join('\n'));
  assert.deepEqual(
    listeners.map(({ port, host, scope }) => ({ port, host, scope })),
    [
      { port: 3000, host: '127.0.0.1', scope: 'local' },
      { port: 3001, host: '::1', scope: 'local' },
      { port: 4000, host: '0.0.0.0', scope: 'all' },
    ],
  );
});

test('process table parsing retains lineage, elapsed time and redacts credentials', () => {
  const parsed = parseProcessTable([
    '100 1 01:02:03 /Applications/Pi Studio --token=secret-value',
    '200 100 2-01:00:04 node server.js --api-key abc123',
    'not a process row',
  ].join('\n'), 10_000_000);
  assert.equal(parseElapsedSeconds('2-01:00:04'), 176_404);
  assert.equal(parsed.get(100).ppid, 1);
  assert.equal(parsed.get(100).elapsedSeconds, 3_723);
  assert.doesNotMatch(parsed.get(100).command, /secret-value/);
  assert.doesNotMatch(parsed.get(200).command, /abc123/);
  assert.match(parsed.get(200).command, /\[redacted]/);
  assert.ok(parsed.get(200).startedAt < 10_000_000);
});

test('descendant and path ownership avoid prefix false positives', () => {
  const processes = new Map([
    [100, { pid: 100, ppid: 1 }],
    [200, { pid: 200, ppid: 100 }],
    [201, { pid: 201, ppid: 200 }],
  ]);
  const descendants = descendantsOf(100, processes);
  assert.deepEqual([...descendants].sort((a, b) => a - b), [200, 201]);
  assert.equal(pathWithin('/workspace/project/server', '/workspace/project'), true);
  assert.equal(pathWithin('/workspace/project-other', '/workspace/project'), false);
  assert.deepEqual(classifyOwnership({
    pid: 201,
    processInfo: processes.get(201),
    processCwd: '/workspace/project/server',
    descendantPids: descendants,
    roots: ['/workspace/project'],
    studioPid: 100,
  }), {
    kind: 'agent',
    evidence: ['Studio 子进程', '当前工作区'],
  });
});

test('service ownership roots must match a Studio-registered workspace', () => {
  assert.deepEqual(selectRegisteredRoots(
    ['/workspace/project', '/workspace/project/child', '/workspace/unregistered'],
    ['/workspace/project', '/workspace/other'],
  ), ['/workspace/project']);
});

test('scanner distinguishes task-owned listeners and marks newly observed ports', async () => {
  const workspace = path.resolve('/workspace/project');
  let listenerOutput = [
    'p200',
    'cnode',
    'n127.0.0.1:3000',
    'p100',
    'cElectron',
    'n127.0.0.1:2999',
    'p300',
    'cOtherApp',
    'n*:9000',
  ].join('\n');
  const execute = async (file, args) => {
    if (file === 'lsof' && args.includes('-FpcPn')) return listenerOutput;
    if (file === 'ps') {
      return [
        '100 1 10:00 /Applications/Pi Studio',
        '200 100 00:30 node server.js',
        '300 1 01:00 OtherApp',
      ].join('\n');
    }
    if (file === 'lsof' && args.includes('-d')) {
      return `p200\nfcwd\nn${workspace}/server\np300\nfcwd\nn/Applications/OtherApp`;
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };
  let now = 1_000_000;
  const terminated = [];
  const scanner = createRuntimeServiceScanner({
    execute,
    platform: 'darwin',
    processId: 100,
    now: () => now,
    stopProcess: async (pid) => {
      terminated.push(pid);
      return { forced: false };
    },
  });

  const first = await scanner.scan({ cwd: workspace });
  assert.equal(first.summary.total, 3);
  assert.equal(first.summary.related, 1);
  assert.equal(first.summary.agent, 1);
  assert.equal(first.summary.other, 1);
  assert.equal(first.services[0].ownership, 'agent');
  assert.equal(first.services[0].isNew, false);
  assert.equal(first.services[0].url, 'http://127.0.0.1:3000');
  assert.deepEqual(
    await scanner.stop({ cwd: workspace, pid: 200, port: 3000 }),
    { ok: true, pid: 200, port: 3000, affectedPorts: [3000], forced: false },
  );
  assert.deepEqual(terminated, [200]);
  await assert.rejects(
    scanner.stop({ cwd: workspace, pid: 100, port: 2999 }),
    /不能终止 Studio 主进程/,
  );

  now += 2_500;
  listenerOutput = [
    'p200',
    'cnode',
    'n127.0.0.1:3000',
    'p201',
    'cnode',
    'n127.0.0.1:3001',
    'p100',
    'cElectron',
    'n127.0.0.1:2999',
    'p300',
    'cOtherApp',
    'n*:9000',
  ].join('\n');
  const second = await scanner.scan({ cwd: workspace });
  const newService = second.services.find((service) => service.port === 3001);
  assert.equal(newService.isNew, true);
  assert.equal(second.summary.total, 4);
});

test('redactCommand removes common shell and API credentials', () => {
  const command = redactCommand(
    'node app.js --token=plain-token --password hunter2 ghp_abcdefghijk sk-livevalue123',
  );
  assert.doesNotMatch(command, /plain-token|hunter2|ghp_abcdefghijk|sk-livevalue123/);
  assert.match(command, /\[redacted]/);
});

test('terminateProcess uses a bounded graceful stop before forcing the process', async () => {
  let alive = true;
  const signals = [];
  const graceful = await terminateProcess(42, {
    platform: 'linux',
    killProcess: (_pid, signal) => {
      signals.push(signal);
      if (signal === 'SIGTERM') alive = false;
    },
    isAlive: () => alive,
    wait: async () => {},
  });
  assert.deepEqual(graceful, { forced: false });
  assert.deepEqual(signals, ['SIGTERM']);

  alive = true;
  signals.length = 0;
  const forced = await terminateProcess(43, {
    platform: 'linux',
    killProcess: (_pid, signal) => {
      signals.push(signal);
      if (signal === 'SIGKILL') alive = false;
    },
    isAlive: () => alive,
    wait: async () => {},
  });
  assert.deepEqual(forced, { forced: true });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('processIsAlive distinguishes gone processes from inaccessible processes', () => {
  assert.equal(processIsAlive(42, () => {}), true);
  assert.equal(processIsAlive(42, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }), true);
  assert.equal(processIsAlive(42, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }), false);
});
