const assert = require('node:assert/strict');
const test = require('node:test');
const dataView = require('../../electron/main/services/extension-data-view.cjs');
const state = require('../../electron/main/core/state.cjs');
const { createWorkbenchTools } = require('../../electron/main/capabilities/workbench/index.cjs');

test('workbench_refresh re-reads active extension data views and notifies main window scopes', async () => {
  const emitted = [];
  const windowMessages = [];
  const service = dataView.createExtensionDataViewService({
    normalizeContentList: (value) => value,
    emit(_target, channel, payload) {
      emitted.push({ channel, payload });
    },
  });
  const unregister = dataView.registerExtensionDataViewService(service);
  const target = { id: 42, isDestroyed: () => false };
  let dbCount = 1;

  state.setWindow({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send(channel, payload) {
        windowMessages.push({ channel, payload });
      },
    },
  });

  try {
    await service.open(
      {
        sourceId: 'user:studio.task-board/board-data',
        view: true,
        viewScope: 'global',
        target,
        owner: { manifestId: 'studio.task-board', scope: 'user' },
      },
      {
        read() {
          return { viewData: { total: dbCount } };
        },
      },
    );

    dbCount = 7;
    const extension = createWorkbenchTools({
      defineExtension: (spec) => spec,
      defineTool: (spec) => spec,
    });
    const tool = extension.tools.find((item) => item.name === 'workbench_refresh');
    assert.ok(tool);

    const res = JSON.parse((await tool.execute({ scope: 'all' })).output[0].text);
    assert.deepEqual(res, {
      refreshed: true,
      scope: 'all',
      refreshedDataViews: 1,
      windowNotified: true,
    });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].channel, 'pi:extension-data-view');
    assert.deepEqual(emitted[0].payload.snapshot.viewData, { total: 7 });
    assert.deepEqual(windowMessages, [
      { channel: 'pi:workbench-refresh', payload: { scope: 'all' } },
    ]);
  } finally {
    unregister();
    state.setWindow(undefined);
  }
});
