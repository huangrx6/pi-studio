import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../../web/src/shell/useAppSettings.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('useAppSettings.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['acceptExtensionResources', 'runExtensionWrite', 'refreshSavedExtensionConfiguration', 'deleteExtension', 'toggleExtension', 'trustExtension', 'rollbackExtension', 'reloadExtensions'];
const extracted = new Map();
function visit(node) { if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) extracted.set(node.name.text, node.getText(ast)); ts.forEachChild(node, visit); }
visit(ast); for (const name of names) assert.ok(extracted.has(name), name);
const code = ts.transpileModule([...extracted.values()].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const ready = (token = 'receipt', extensions = [{ id: 'item', version: '2' }]) => ({ committed: true, recoveryToken: token, projection: { status: 'ready', value: { extensions, extensionErrors: [], mcp: ['must-not-replace'], providers: ['must-not-replace'] } } });
const failed = () => ({ ...ready(), projection: { status: 'error', message: 'postprocessing failed' } });
function harness() {
  const calls = [], notices = [], errors = [], confirmations = [];
  const h = {
    settings: { extensions: [{ id: 'item', version: '1' }], extensionErrors: ['old'], mcp: ['current MCP'], providers: ['current provider'] }, detail: { id: 'item', version: '1' },
    resourceWriteRef: { current: null }, resourceCommitRef: { current: null }, editorSaveRef: { current: null }, settingsBusy: false,
    workspaceRef: { current: '/A' }, settingsRequestRef: { current: 1 }, extensionRefreshRequestRef: { current: 1 }, extensionRefreshLockRef: { current: false }, extensionMutationReceiptsRef: { current: new Map() },
    setSettingsData(update) { h.settings = typeof update === 'function' ? update(h.settings) : update; },
    setExtensionDetail(update) { h.detail = typeof update === 'function' ? update(h.detail) : update; },
    setResourceWriteBusy(value) { h.writeBusy = value; }, setExtensionRefreshBusy(value) { h.refreshBusy = value; },
    setSettingsError(value) { errors.push(value); }, setExtensionRefreshError(value) { notices.push(value); },
    invalidateResourceReads() { h.settingsRequestRef.current++; h.extensionRefreshRequestRef.current++; },
    errorText: error => String(error.message || error), pushNotification: (...args) => calls.push(['notification', ...args]),
    actionConfirmation: { confirm: async value => { confirmations.push(value); return true; } },
    window: { piApi: {} },
  };
  for (const method of ['removeExtension', 'setExtensionEnabled', 'setExtensionTrusted', 'rollbackExtension']) h.window.piApi[method] = async input => { calls.push([method, input]); return failed(); };
  h.window.piApi.refreshExtensionMutation = async token => { calls.push(['refresh', token]); return ready(token); };
  h.window.piApi.settings = async cwd => { calls.push(['settings', cwd]); return ready().projection.value; };
  h.window.piApi.disposeExtensionMutationRecovery = async token => { calls.push(['dispose', token]); };
  h.window.piApi.reloadExtensions = async cwd => { calls.push(['reload', cwd]); };
  vm.runInNewContext(code, h);
  return { h, calls, notices, errors, confirmations };
}
const item = { id: 'item', name: '扩展', scope: 'project', installation: { canRollback: true } };

test('actual four mutation callbacks retain committed failure, recover without repeating writes, and merge only extension data', async () => {
  for (const [action, args, method] of [
    ['deleteExtension', ['item', '扩展'], 'removeExtension'], ['toggleExtension', [item, false], 'setExtensionEnabled'],
    ['trustExtension', [item, true], 'setExtensionTrusted'], ['rollbackExtension', [item], 'rollbackExtension'],
  ]) {
    const { h, calls, notices } = harness(); await h[action](...args);
    assert.equal(h.extensionMutationReceiptsRef.current.size, 1); assert.match(notices.at(-1), /postprocessing failed/);
    await h[action](...args); assert.equal(calls.filter(([name]) => name === method).length, 1);
    await h.refreshSavedExtensionConfiguration();
    assert.equal(h.extensionMutationReceiptsRef.current.size, 0); assert.equal(notices.at(-1), null);
    assert.equal(calls.filter(([name]) => name === method).length, 1); assert.equal(calls.filter(([name]) => name === 'refresh').length, 1);
    assert.deepEqual(h.settings.mcp, ['current MCP']); assert.deepEqual(h.settings.providers, ['current provider']);
    assert.equal(h.settings.extensions[0].version, '2'); assert.equal(calls.filter(([name]) => name === 'dispose').length, 1);
  }
});

test('confirmation and physical write are synchronously locked; canceled or obsolete confirmations do not mutate', async () => {
  const { h, calls } = harness(), confirmation = deferred(); h.actionConfirmation.confirm = () => confirmation.promise;
  const first = h.trustExtension(item, true); await h.deleteExtension('item', '扩展'); assert.equal(calls.length, 0);
  confirmation.resolve(false); await first; assert.equal(calls.length, 0); assert.equal(h.resourceWriteRef.current, null);
  const second = deferred(); h.actionConfirmation.confirm = () => second.promise;
  const attempt = h.trustExtension(item, true); h.workspaceRef.current = '/B'; second.resolve(true); await attempt; assert.equal(calls.length, 0);
});

test('late committed ready result survives workspace change and closed detail without applying its old snapshot', async () => {
  const { h, calls, notices } = harness(), pending = deferred();
  h.window.piApi.setExtensionEnabled = async input => { calls.push(['write', input]); return pending.promise; };
  const work = h.toggleExtension(item, false); h.workspaceRef.current = '/B'; h.detail = null;
  pending.resolve(ready()); await work;
  assert.equal(h.settings.extensions[0].version, '1'); assert.equal(h.detail, null); assert.equal(h.extensionMutationReceiptsRef.current.size, 1); assert.match(notices.at(-1), /刷新/);
  await h.refreshSavedExtensionConfiguration();
  assert.equal(calls.filter(([name]) => name === 'refresh').length, 0, 'ready receipts need no repeated side effects');
  assert.deepEqual(calls.find(([name]) => name === 'settings'), ['settings', '/B']); assert.equal(h.detail, null);
});

test('ready recovery followed by failed current settings retries only settings and keeps receipt until success', async () => {
  const { h, calls, notices } = harness(); await h.toggleExtension(item, false);
  h.window.piApi.settings = async cwd => { calls.push(['settings', cwd]); throw new Error('read failed'); };
  await h.refreshSavedExtensionConfiguration(); assert.equal(h.extensionMutationReceiptsRef.current.size, 1); assert.equal(notices.at(-1), 'read failed');
  h.window.piApi.settings = async cwd => { calls.push(['settings', cwd]); return ready().projection.value; };
  await h.reloadExtensions();
  assert.equal(calls.filter(([name]) => name === 'refresh').length, 1); assert.equal(calls.filter(([name]) => name === 'settings').length, 2);
  assert.equal(calls.filter(([name]) => name === 'reload').length, 0); assert.equal(h.extensionMutationReceiptsRef.current.size, 0);
});

test('late recovery keeps completed receipt across changed scope/revision and its physical lock blocks concurrent refresh', async () => {
  for (const change of [h => { h.workspaceRef.current = '/B'; }, h => { h.extensionRefreshRequestRef.current++; }]) {
    const { h, calls } = harness(), pending = deferred(); await h.toggleExtension(item, false);
    h.window.piApi.refreshExtensionMutation = async token => { calls.push(['refresh', token]); return pending.promise; };
    const work = h.refreshSavedExtensionConfiguration(); change(h); await h.refreshSavedExtensionConfiguration();
    assert.equal(calls.filter(([name]) => name === 'refresh').length, 1); assert.equal(h.extensionRefreshLockRef.current, true);
    pending.resolve(ready()); await work;
    assert.equal(h.extensionMutationReceiptsRef.current.get('receipt').result.projection.status, 'ready'); assert.equal(h.settings.extensions[0].version, '1');
    assert.equal(h.extensionRefreshLockRef.current, false); await h.refreshSavedExtensionConfiguration();
    assert.equal(calls.filter(([name]) => name === 'refresh').length, 1); assert.equal(h.extensionMutationReceiptsRef.current.size, 0);
  }
});

test('mutation rejects before commit without creating receipt and explicit retry can commit', async () => {
  const { h, errors } = harness(); h.window.piApi.setExtensionEnabled = async () => { throw new Error('not committed'); };
  await h.toggleExtension(item, false); assert.equal(h.extensionMutationReceiptsRef.current.size, 0); assert.equal(errors.at(-1), 'not committed');
  h.window.piApi.setExtensionEnabled = async () => ready(); await h.toggleExtension(item, false); assert.equal(h.settings.extensions[0].version, '2');
});

test('receipt dispose rejection is handled after successful apply, not presented as an uncommitted mutation', async () => {
  const { h, notices, errors } = harness(); h.window.piApi.setExtensionEnabled = async () => ready();
  h.window.piApi.disposeExtensionMutationRecovery = async () => { throw new Error('dispose failed'); };
  await h.toggleExtension(item, false); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.extensionMutationReceiptsRef.current.size, 0); assert.equal(notices.at(-1), null); assert.deepEqual(errors, [null]);
});
