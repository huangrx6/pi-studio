const path = require('node:path');
const manifests = require('./manifest.cjs');
const { createMacLidControl } = require('./mac-lid.cjs');

const id = `builtin:${manifests[0].id}`;
const modeLabels = Object.freeze({ always: '开启', agent: '代理', off: '关闭' });
const settingKey = 'studio.keepAwake.mode';

function hasAgentWork(graph) {
  return Object.values(graph.tasks).some(({ blocked, state, kind }) => {
    if (blocked) return false;
    if (state.status === 'running' || state.status === 'pending') return true;
    // A provider retry or deferred response is still part of the current request.
    return state.status === 'sleeping' && (kind === 'pi.generation' || kind === 'pi.compaction');
  });
}

function createKeepAwake({ db, blocker, powerMonitor, onEnabled, createLidControl }) {
  let mode = db.getSettingWithRecovery(settingKey, 'off', value => typeof value === 'string' && Object.hasOwn(modeLabels, value) ? value : 'off');
  let enabled = db.getExtension(id)?.enabled !== false;
  let blockerId;
  let closed = false;
  let snapshot;
  let lid;
  const sources = new Set();
  const listeners = new Set();

  function reconcile() {
    const observations = [...sources].map(source => source.observation).filter(Boolean);
    const wanted = !closed && enabled && (mode === 'always' || (mode === 'agent' && observations.some(o => o.busy)));
    let active = blockerId !== undefined;
    let error = '';
    try {
      active = blockerId !== undefined && blocker.isStarted(blockerId);
      if (!active) blockerId = undefined;
      if (wanted && !active) blockerId = blocker.start('prevent-app-suspension');
      else if (!wanted && active) blocker.stop(blockerId);
      active = blockerId !== undefined && blocker.isStarted(blockerId);
      if (!active) blockerId = undefined;
      if (active !== wanted) throw new Error();
    } catch {
      error = wanted ? '系统未确认防休眠请求' : '系统未确认释放防休眠请求';
    }
    if (!error && observations.some(o => o.failed)) error = '无法读取代理任务状态';
    let status = '未生效';
    if (error) status = '状态异常';
    else if (active) status = '已生效';
    else if (enabled && mode === 'agent') status = '等待任务';
    lid?.setWanted(wanted && active);
    const lidState = lid?.snapshot;
    if (snapshot?.mode === mode && snapshot.status === status && snapshot.active === active && snapshot.error === error && snapshot.lid === lidState) return;
    snapshot = { mode, active, status, error, label: `${modeLabels[mode]} · ${status}`, ...(lidState && { lid: lidState }) };
    for (const listener of listeners) listener();
  }

  function stopWatching(source) {
    const observation = source.observation;
    source.observation = undefined;
    observation?.watch?.stop();
  }

  async function startWatching(source) {
    // A new mode or a closing harness can supersede an in-flight attachment.
    const observation = { busy: false, failed: false, watch: undefined };
    source.observation = observation;
    try {
      const watch = await source.harness.watchTaskGraph(source.context);
      if (source.observation !== observation) {
        await watch.stop();
        return;
      }
      observation.watch = watch;
      observation.busy = hasAgentWork(watch.value);
      watch.start(call => {
        if (source.observation !== observation || call.kind !== 'value') return;
        const busy = hasAgentWork(call.value);
        if (busy === observation.busy) return;
        observation.busy = busy;
        reconcile();
      });
      reconcile();
      await watch.closed;
    } catch {
      // Surface an unavailable graph in the extension without interrupting the agent.
    }
    if (source.observation !== observation) return;
    observation.watch?.stop();
    observation.busy = false;
    observation.failed = true;
    reconcile();
  }

  function configure(retry = false) {
    for (const source of sources) {
      if (closed || !enabled || mode !== 'agent') stopWatching(source);
      else if (!source.observation || (retry && source.observation.failed)) void startWatching(source);
    }
    reconcile();
  }

  function addHarness(harness, context) {
    const source = { harness, context };
    sources.add(source);
    configure();
    return () => {
      sources.delete(source);
      stopWatching(source);
      reconcile();
    };
  }

  function setMode(value) {
    if (closed || !enabled) throw new Error('防止电脑休眠扩展已停用');
    if (typeof value !== 'string' || !Object.hasOwn(modeLabels, value)) throw new Error('防休眠模式无效');
    if (value !== mode) {
      db.setSetting(settingKey, value);
      mode = value;
    }
    configure(true);
    return snapshot;
  }

  function provider(read) {
    return {
      read,
      retainOnReload: () => enabled && !closed,
      subscribe(_context, emit) {
        const update = () => emit(read());
        listeners.add(update);
        update();
        return () => listeners.delete(update);
      },
    };
  }

  const offEnabled = onEnabled(id, value => {
    enabled = value;
    if (!enabled && lid?.snapshot) lid.setEnabled(false);
    configure();
  });
  lid = createLidControl?.({ onChange: reconcile, powerMonitor });
  const resume = () => configure(true);
  powerMonitor?.on('resume', resume);
  reconcile();
  return {
    addHarness,
    dataSources: {
      [`${id}/summary`]: provider(() => [{
        kind: 'text', text: snapshot.label,
      }]),
      [`${id}/control`]: {
        ...provider(() => ({ viewData: snapshot })),
        invoke(_context, method, params) {
          if (method === 'setLidEnabled') {
            if (closed || !enabled || !lid || typeof params?.enabled !== 'boolean') throw new Error('无法更改合盖运行设置');
            lid.setEnabled(params.enabled);
            return snapshot;
          }
          if (method !== 'setMode') throw new Error('不支持的防休眠操作');
          return setMode(params?.mode);
        },
      },
    },
    close() {
      closed = true;
      lid?.close();
      offEnabled();
      powerMonitor?.removeListener('resume', resume);
      configure();
      sources.clear();
      listeners.clear();
    },
  };
}

module.exports = {
  manifests,
  create: ({ durable }) => new Map([[id, durable.defineExtension({ name: manifests[0].runtimeName })]]),
  createKeepAwake,
  createMacLidControl,
  viewDirectories: { [id]: path.join(__dirname, 'ui') },
};
