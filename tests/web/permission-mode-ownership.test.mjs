import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../../web/src/shell/usePermissionControl.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('usePermissionControl.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const wanted = new Set([
  'acceptPermissionState',
  'applyPermission',
  'readPermissionForScope',
  'retryPermissionMode',
  'writePermissionForScope',
]);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text)) functions.push(node.getText(tree));
  else ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(functions.length, wanted.size, 'all permission ownership functions must be extracted');
const code = ts.transpileModule(
  `${functions.join('\n')}
globalThis.accept = acceptPermissionState;
globalThis.apply = applyPermission;
globalThis.read = readPermissionForScope;
globalThis.retry = retryPermissionMode;
globalThis.write = writePermissionForScope;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function harness({
  scopeKey = 'A\0A',
  workspace = '/A',
  sessionId = 'A',
  permission = { scopeKey, available: true, mode: 'smart', status: 'ready' },
} = {}) {
  const readRequests = new Map();
  const writeRequests = [];
  const h = {
    permission,
    visiblePermission: permission,
    permissionScopeKeyRef: { current: scopeKey },
    permissionReadRequestRef: { current: 1 },
    permissionWriteRequestRef: { current: 0 },
    workspace,
    sessionId,
    session: sessionId ? { id: sessionId } : null,
    errors: [],
    setPermission(value) {
      h.permission = typeof value === 'function' ? value(h.permission) : value;
      h.visiblePermission = h.permission;
    },
    setError(value) { h.errors.push(value); },
    errorText: (error) => error?.message || String(error),
    window: {
      piApi: {
        modeGet(payload) {
          const request = deferred();
          readRequests.set(payload.sessionId || payload.cwd, request);
          return request.promise;
        },
        modeSet(payload) {
          const request = deferred();
          writeRequests.push({ payload, request });
          return request.promise;
        },
      },
    },
  };
  vm.runInNewContext(code, h);
  return { h, readRequests, writeRequests };
}

test('a read from an old workspace cannot replace the current permission mode', async () => {
  const { h, readRequests } = harness();
  const oldRead = h.read('A\0A', { workspace: '/A', sessionId: 'A' }, 1);
  h.permissionScopeKeyRef.current = 'B\0B';
  h.permissionReadRequestRef.current = 2;
  const currentRead = h.read('B\0B', { workspace: '/B', sessionId: 'B' }, 2);

  readRequests.get('B').resolve({ available: true, mode: 'ask' });
  await currentRead;
  assert.equal(h.permission.mode, 'ask');
  assert.equal(h.permission.scopeKey, 'B\0B');

  readRequests.get('A').resolve({ available: true, mode: 'full' });
  await oldRead;
  assert.equal(JSON.stringify(h.permission), JSON.stringify({ scopeKey: 'B\0B', available: true, mode: 'ask', status: 'ready' }));
});

test('an in-flight read cannot overwrite a newer local mode change', async () => {
  const { h, readRequests, writeRequests } = harness();
  const staleRead = h.read('A\0A', { cwd: '/A', sessionId: 'A' }, 1);
  const write = h.apply('ask');
  assert.equal(h.permission.mode, 'ask', 'the selected mode is shown immediately');

  readRequests.get('A').resolve({ available: true, mode: 'full' });
  await staleRead;
  assert.equal(h.permission.mode, 'ask', 'the older read does not restore a stale mode');

  writeRequests[0].request.resolve({ available: true, mode: 'ask', applied: true });
  await write;
  assert.equal(JSON.stringify(writeRequests[0].payload), JSON.stringify({
    mode: 'ask',
    scope: 'session',
    cwd: '/A',
    sessionId: 'A',
  }));
  assert.equal(h.permission.mode, 'ask');
});

test('only the newest mode write can update or roll back the visible selector', async () => {
  const { h, writeRequests } = harness();
  const first = h.apply('ask');
  const second = h.apply('full');

  writeRequests[0].request.reject(new Error('old request failed'));
  await first;
  assert.equal(h.permission.mode, 'full', 'an older rejection cannot roll back the newer selection');
  assert.deepEqual(h.errors, []);

  writeRequests[1].request.resolve({ available: true, mode: 'full', applied: true });
  await second;
  assert.equal(h.permission.mode, 'full');
});

test('a late write result cannot leak into another scope', async () => {
  const { h, writeRequests } = harness();
  const write = h.apply('ask');
  h.permissionScopeKeyRef.current = 'B\0B';
  h.setPermission({ scopeKey: 'B\0B', available: false, mode: 'smart', status: 'loading' });

  writeRequests[0].request.resolve({ available: true, mode: 'ask', applied: true });
  await write;
  assert.equal(JSON.stringify(h.permission), JSON.stringify({ scopeKey: 'B\0B', available: false, mode: 'smart', status: 'loading' }));

  const failed = await h.apply('full');
  assert.equal(failed, undefined, 'a hidden scope cannot start another mode write');
  assert.equal(writeRequests.length, 1);
});

test('a saved settings-policy result supersedes an older mode read', async () => {
  const { h, readRequests } = harness();
  const staleRead = h.read('A\0A', { cwd: '/A', sessionId: 'A' }, 1);
  h.accept({ available: true, mode: 'ask' });
  readRequests.get('A').resolve({ available: true, mode: 'full' });
  await staleRead;
  assert.equal(JSON.stringify(h.permission), JSON.stringify({ scopeKey: 'A\0A', available: true, mode: 'ask', status: 'ready' }));
});

test('failed current reads hide the stale selector and expose an explicit retry', async () => {
  const { h, readRequests } = harness();
  const read = h.read('A\0A', { cwd: '/A', sessionId: 'A' }, 1);
  readRequests.get('A').reject(new Error('offline'));
  await read;
  assert.equal(JSON.stringify(h.permission), JSON.stringify({ scopeKey: 'A\0A', available: false, mode: 'smart', status: 'error' }));

  const retry = h.retry();
  assert.equal(h.permission.status, 'loading');
  readRequests.get('A').resolve({ available: true, mode: 'full' });
  await retry;
  assert.equal(JSON.stringify(h.permission), JSON.stringify({ scopeKey: 'A\0A', available: true, mode: 'full', status: 'ready' }));
});
