const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

/**
 * 以独立 VM 加载会话服务，避免测试改动主进程的全局 AgentSession 缓存。
 */
function loadSessionsService({ session, manager = { getEntries: () => [] }, cwd = '/fixture' }) {
  const filename = path.join(__dirname, '../electron/services/sessions.cjs');
  const nativeRequire = createRequire(filename);
  const agentSessions = new Map([['session-1', session]]);
  const models = session.testModels;
  const runtime = {
    getModel: (provider, modelId) => models.get(`${provider}/${modelId}`),
    getModels: () => [...models.values()],
  };
  const noop = () => {};
  const deps = {
    '../core/state.cjs': {
      DEFAULT_CWD: '/fixture',
      piModule: () => ({}),
      getRuntime: async () => runtime,
      getModelRef: () => `${[...models.values()][0].provider}/${[...models.values()][0].id}`,
      readAuth: () => ({}),
      readConfig: () => ({}),
      writeConfig: noop,
      modelsFile: () => '/fixture/models.json',
      mcpFile: () => '/fixture/mcp.json',
      agentDir: () => '/fixture/agent',
      configPath: () => '/fixture/config.json',
      agentSessions,
      syncModelRefFromPiDefault: noop,
    },
    '../core/serialize.cjs': { serializeMessage: noop, visibleSessionMessages: () => [] },
    '../core/attachment-markers.cjs': { parseAttachmentMarkers: () => [] },
    './models.cjs': {
      reasoningFor: noop,
      resolvedRuntimeModel: () => [...models.values()][0],
      runtimeModelFor: (runtimeValue, modelRef) => {
        const [provider, ...parts] = modelRef.split('/');
        return runtimeValue.getModel(provider, parts.join('/'));
      },
      modelInfoFor: (model, _cwd, thinkingLevel) => ({
        modelRef: `${model.provider}/${model.id}`,
        label: model.name,
        thinkingLevel: thinkingLevel || model.defaultThinkingLevel || 'medium',
        thinkingLevels: ['default', 'low', 'medium', 'high', 'max'],
        effectiveThinkingLevel: thinkingLevel || model.defaultThinkingLevel || 'medium',
        defaultThinkingLevel: model.defaultThinkingLevel || 'medium',
      }),
    },
    './session-model.cjs': { resolveSessionModel: () => ({}) },
    './extensions.cjs': { createExtensionUI: noop },
    '../sidebar-state.cjs': { updateSidebar: value => value },
    '../credential-env.cjs': { envNameOf: () => undefined },
    './mode.cjs': { consumePendingMode: () => undefined },
    './session-title.cjs': { sessionTitle: () => 'Session' },
    './turn-diff.cjs': { readTurnDiffs: () => [], beginTurn: async () => null, endTurn: async () => null, saveTurnDiff: noop },
    './auto-title.cjs': { temporaryTitle: () => 'Session', createAutoTitleGenerator: () => ({ generate: async () => {} }) },
    '../settings-config.cjs': { readAgentToolSelection: () => ({ enabled: [] }) },
    './subagent-runtime.cjs': { clearSubagentRuntime: noop },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    require: name => {
      if (name in deps) return deps[name];
      return nativeRequire(name);
    },
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
  }, { filename });
  module.exports.drafts.set('session-1', { manager, cwd });
  return { service: module.exports, agentSessions };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function model(provider, id, thinkingLevel = 'medium') {
  return { provider, id, name: id, defaultThinkingLevel: thinkingLevel };
}

function busySession(initialModel) {
  const idle = deferred();
  const setModelCalls = [];
  const thinkingChanges = [];
  const session = {
    model: initialModel,
    thinkingLevel: 'medium',
    isStreaming: true,
    isCompacting: false,
    isIdle: false,
    testModels: new Map(),
    waitForIdle: () => idle.promise,
    setModel: async (nextModel) => {
      setModelCalls.push(`${nextModel.provider}/${nextModel.id}`);
      session.model = nextModel;
    },
    setThinkingLevel: (level) => {
      thinkingChanges.push(level);
      session.thinkingLevel = level;
    },
  };
  return { session, idle, setModelCalls, thinkingChanges };
}

test('a model selected during a run is queued, coalesced, and applied only after idle', async () => {
  const current = model('provider', 'current');
  const first = model('provider', 'first');
  const latest = model('provider', 'latest');
  const fixture = busySession(current);
  fixture.session.testModels = new Map([
    ['provider/current', current],
    ['provider/first', first],
    ['provider/latest', latest],
  ]);
  const { service } = loadSessionsService({ session: fixture.session });

  const firstSelection = await service.setSessionModel('session-1', 'provider/first');
  const latestSelection = await service.setSessionModel('session-1', 'provider/latest');
  assert.equal(firstSelection.pending, true);
  assert.equal(latestSelection.pending, true);
  assert.equal(latestSelection.modelRef, 'provider/latest');
  assert.equal(fixture.session.model, current, 'the active reply must keep its original model');
  assert.deepEqual(fixture.setModelCalls, []);

  const thinkingSelection = await service.setSessionThinking('session-1', 'high');
  assert.equal(thinkingSelection.modelRef, 'provider/latest');
  assert.equal(thinkingSelection.pending, true, 'thinking refresh must not clear the pending model');

  fixture.session.isStreaming = false;
  fixture.session.isIdle = true;
  fixture.idle.resolve();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(fixture.setModelCalls, ['provider/latest']);
  assert.equal(fixture.session.model, latest);
  assert.equal(await service.applyPendingSessionModel('session-1', fixture.session), false);
  assert.deepEqual(fixture.setModelCalls, ['provider/latest'], 'the queued change must apply only once');
});

test('choosing the active model again cancels a queued switch', async () => {
  const current = model('provider', 'current');
  const next = model('provider', 'next');
  const fixture = busySession(current);
  fixture.session.testModels = new Map([
    ['provider/current', current],
    ['provider/next', next],
  ]);
  const { service } = loadSessionsService({ session: fixture.session });

  await service.setSessionModel('session-1', 'provider/next');
  const restored = await service.setSessionModel('session-1', 'provider/current');
  assert.equal(restored.pending, undefined);

  fixture.session.isStreaming = false;
  fixture.session.isIdle = true;
  fixture.idle.resolve();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(fixture.setModelCalls, []);
  assert.equal(fixture.session.model, current);
});
