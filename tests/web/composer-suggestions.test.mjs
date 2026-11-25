import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { errorText } from '../../web/src/shared/error-text.ts';
import { composerKeyAction } from '../../web/src/features/conversation/composer-submit.ts';
import { composerMenuAt } from '../../web/src/features/conversation/composer-menu.ts';

function harness(api, profiles = []) {
  const states = []; let cursor = 0, previousDeps, effect, cleanup, timer;
  const react = {
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], update => { states[index] = typeof update === 'function' ? update(states[index]) : update; }]; },
    useMemo(fn) { return fn(); },
    useEffect(next, deps) { if (!previousDeps || deps.some((value, index) => !Object.is(value, previousDeps[index]))) { previousDeps = deps; effect = next; } },
  };
  const module = { exports: {} };
  const source = fs.readFileSync(new URL('../../web/src/features/conversation/useComposerSuggestions.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, window: { piApi: api },
    setTimeout(fn) { timer = fn; return 1; }, clearTimeout() { timer = undefined; },
    require(name) {
      if (name === 'react') return react;
      if (name === '../subagents/useSubagentProfiles') return {
        useSubagentProfiles: () => ({ rows: profiles, ready: true, error: '' }), refreshSubagentProfiles: async () => {},
      };
      assert.equal(name, '../../shared/error-text');
      return { errorText };
    },
  });
  return {
    render(menu, cwd = '/a', sessionId = 'a') { cursor = 0; return module.exports.useComposerSuggestions(menu, cwd, sessionId); },
    commit() { if (effect) { cleanup?.(); cleanup = effect(); effect = undefined; } },
    debounce() { const run = timer; timer = undefined; run?.(); },
    unmount() { cleanup?.(); },
  };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const file = query => ({ kind: 'file', query, start: 0, end: query.length + 1 });
const slash = { kind: 'slash', query: '', start: 0, end: 1 };

test('sigils dispatch to distinct pickers and keep emails, issue numbers and shell syntax literal', () => {
  for (const [text, kind] of [['请@README','file'], ['#审阅','agent'], ['$工具','capability'], ['/model','slash']]) {
    assert.equal(composerMenuAt(text, text.length)?.kind, kind);
  }
  for (const text of ['user@example.org', '#123', '# 标题', '$PATH', '$1', '$(', '$$', 'cost$9', '@"draft #name.md"']) {
    assert.equal(composerMenuAt(text, text.length), null, text);
  }
  assert.equal(composerMenuAt('$echo', 5, { kind: 'capability', start: 0, capabilityType: 'mcp' }).capabilityType, 'mcp');
  const serverMenu = { kind: 'capability', start: 0, capabilityType: 'mcp', mcpServer: { id: 'dev', name: 'DevTools', parentQuery: 'dev' } };
  assert.deepEqual(composerMenuAt('$click', 6, serverMenu).mcpServer, serverMenu.mcpServer);
  assert.equal(composerMenuAt('$click $', 8, serverMenu).mcpServer, undefined);
  const menu = composerMenuAt('$Toolkit', 8);
  assert.equal(composerMenuAt('$Toolkit Starter', 16, menu).query, 'Toolkit Starter');
  assert.equal(composerMenuAt('$MCP', 4).kind, 'capability');
});

test('dollar suggestions wait for a category and filter resources within that category', async () => {
  let calls = 0;
  const caps = [{ type: 'skill', id: 'a', name: 'echo', description: '', source: '插件 · 同源' },
    { type: 'mcp-server', id: 'plugin-api', name: 'api', description: '参考文档', server: 'api', source: '插件 · 同源', methodCount: 1 },
    { type: 'mcp-server', id: 'user-api', name: 'api', description: '', server: 'api', source: '个人配置', methodCount: 1 },
    { type: 'mcp', id: 'b', name: 'echo', description: '', server: 'api', serverId: 'plugin-api', source: '插件 · 同源' },
    { type: 'mcp', id: 'c', name: 'echo', description: '', server: 'api', serverId: 'user-api', source: '个人配置' },
    { type: 'plugin', id: 'studio.shared', name: '同源', description: '', source: 'Studio' }];
  const h = harness({ composerResources: async () => { calls++; return { commands: [], skills: [], capabilities: caps }; },
    searchFiles: async () => ({ files: [{ name: 'README', path: 'README', type: 'file' }] }) }, [
    { id: 'role', name: '审阅', description: '', avatarId: 'indigo-bob' }]);
  h.render(file('')); h.commit(); h.debounce(); await flush();
  assert.deepEqual(Array.from(h.render(file('')).mentions, x => x.type), ['file']);
  assert.deepEqual(Array.from(h.render({ ...file(''), kind: 'agent' }).mentions, x => x.type), ['agent']);
  const menu = { ...file('同源'), kind: 'capability' };
  h.render(menu); h.commit(); await flush();
  assert.equal(calls, 0);
  assert.equal(h.render(menu).loading, false);
  assert.equal(h.render(menu).mentions.length, 0);
  const mcp = { ...menu, capabilityType: 'mcp' };
  assert.equal(h.render(mcp).loading, true);
  h.commit(); await flush();
  const ids = overrides => Array.from(h.render({ ...mcp, ...overrides }).mentions, x => x.id);
  assert.deepEqual(ids({}), ['plugin-api']);
  assert.deepEqual(ids({ query: '' }), ['plugin-api', 'user-api']);
  assert.deepEqual(ids({ query: 'echo' }), ['b', 'c']);
  assert.deepEqual(ids({ query: 'api/echo' }), ['b', 'c']);
  assert.deepEqual(ids({ mcpServer: { id: 'user-api', name: 'api', parentQuery: '' }, query: '' }), ['c']);
  assert.deepEqual(Array.from(h.render({ ...menu, query: 'studio.shared', capabilityType: 'plugin' }).mentions, x => x.id), ['studio.shared']);
  assert.equal(calls, 1);
  assert.equal(h.render(menu).mentions.length, 0);
});

test('changed file query hides old options before effects and ignores late completion', async () => {
  const old = deferred(), fresh = deferred();
  const h = harness({ searchFiles: ({ query }) => query === 'old' ? old.promise : fresh.promise });
  h.render(file('old')); h.commit(); h.debounce();
  const pending = h.render(file('fresh')); assert.equal(pending.mentions.length, 0); assert.equal(pending.loading, true); h.commit(); h.debounce();
  fresh.resolve({ files: [{ path: 'fresh.md' }] }); await flush(); old.resolve({ files: [{ path: 'old.md' }] }); await flush();
  assert.equal(h.render(file('fresh')).mentions[0].path, 'fresh.md');
  assert.equal(h.render(file('third')).mentions.length, 0);
});

test('closing invalidates command request and cannot clear another menu loading state', async () => {
  const commands = deferred(), files = deferred();
  const h = harness({ composerResources: () => commands.promise, searchFiles: () => files.promise });
  h.render(slash); h.commit(); h.render(file('read')); h.commit(); h.debounce();
  commands.resolve({ commands: [{ name: 'obsolete' }], skills: [] }); await flush();
  assert.equal(h.render(file('read')).loading, true); assert.equal(h.render(file('read')).commands.length, 0);
  h.render(null); h.commit(); files.resolve({ files: [{ path: 'late.md' }] }); await flush();
  assert.equal(h.render(null).mentions.length, 0); assert.equal(h.render(null).loading, false);
});

test('context changes hide commands and failed reads expose a real retry without old choices', async () => {
  let next = deferred(); let calls = 0;
  const h = harness({ composerResources: () => { calls++; return next.promise; } });
  h.render(slash); h.commit(); next.resolve({ commands: [{ name: 'workspace_a', description: '' }], skills: [] }); await flush();
  assert.equal(h.render(slash).commandOptions.length, 1);
  next = deferred(); const b = h.render(slash, '/b', 'b'); assert.equal(b.commands.length, 0); assert.equal(b.commandOptions.length, 0); h.commit();
  next.reject(new Error('offline')); await flush(); const failed = h.render(slash, '/b', 'b');
  assert.match(failed.error, /offline/); assert.equal(failed.commandOptions.length, 0);
  next = deferred(); failed.retry(); h.render(slash, '/b', 'b'); h.commit(); next.resolve({ commands: [{ name: 'workspace_b', description: '' }], skills: [] }); await flush();
  assert.equal(h.render(slash, '/b', 'b').commandOptions[0].name, 'workspace_b'); assert.equal(calls, 3); h.unmount();
});

const key = { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, busy: false, menuOpen: true, optionCount: 2 };
test('menu keys preserve IME, multiline and reverse tab; explicit modifier send bypasses suggestions', () => {
  for (const value of ['Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'Escape']) assert.equal(composerKeyAction({ ...key, key: value, isComposing: true }), 'none');
  assert.equal(composerKeyAction({ ...key, shiftKey: true }), 'none');
  assert.equal(composerKeyAction({ ...key, key: 'Tab', shiftKey: true }), 'none');
  assert.equal(composerKeyAction({ ...key, ctrlKey: true }), 'send');
  assert.equal(composerKeyAction({ ...key, metaKey: true, busy: true }), 'queue');
  assert.equal(composerKeyAction(key), 'select');
  assert.equal(composerKeyAction({ ...key, key: 'ArrowRight', canOpenMethods: true }), 'methods');
  assert.equal(composerKeyAction({ ...key, key: 'ArrowRight', canOpenMethods: false }), 'none');
  assert.equal(composerKeyAction({ ...key, key: 'ArrowRight', canOpenMethods: true, isComposing: true }), 'none');
  assert.equal(composerKeyAction({ ...key, key: 'Escape', optionCount: 0 }), 'close');
  assert.equal(composerKeyAction({ ...key, optionCount: 0, pending: true }), 'wait');
});
