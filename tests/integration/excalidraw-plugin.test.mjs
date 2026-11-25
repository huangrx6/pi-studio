import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activate } from '../../assets/official-plugins/packages/excalidraw/extension/extension.mjs';
import { planDiagram } from '../../assets/official-plugins/packages/excalidraw/extension/diagram.mjs';
import { normalizeCanvasScene } from '../../assets/official-plugins/packages/excalidraw/extension/scene.mjs';

const sceneArgs = {
  title: '审阅',
  nodes: [{ id: 'a', label: '草案' }, { id: 'b', label: '评审', shape: 'diamond' }],
  edges: [{ from: 'a', to: 'b', label: '确认' }, { from: 'b', to: 'a', dashed: true }],
};

test('the standalone excalidraw plugin publishes playback scenes, saves per-conversation data, and accepts generic view invokes', async t => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'studio-board-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const revealed = [];
  const activated = activate({ dataDirectory, revealPanel: (...event) => revealed.push(event) });
  const [draw, read] = activated.durableExtension.tools;
  const provider = activated.dataSources.scene;
  const context = { durableSessionId: '17' };
  const snapshots = [];
  const dispose = provider.subscribe(context, value => snapshots.push(value.viewData));
  try {
    await draw.execute(sceneArgs, { conversationId: 17 });
    assert.deepEqual(revealed, [['board', 17]]);
    assert.ok(snapshots.some(snapshot => snapshot.drawing && snapshot.playback?.firstElement === 0));
    const final = provider.read(context).viewData;
    assert.equal(final.revision, 1);
    assert.equal(final.drawing, false);
    assert.equal(final.scene.elements.length, 7);
    assert.equal(provider.read({ durableSessionId: '18' }).viewData.scene.elements.length, 0);

    const details = JSON.parse((await read.execute({}, { conversationId: 17 })).output[0].text);
    assert.equal(details.nodes[1].label, '评审');
    assert.equal(details.edges[1].to, 'a');

    assert.throws(() => provider.invoke(context, 'save', { revision: 0, scene: final.scene }), /读取最新版本/);
    const edited = provider.invoke(context, 'save', {
      revision: 1,
      scene: { ...final.scene, elements: final.scene.elements.slice(0, 2) },
    });
    assert.equal(edited.revision, 2);

    const abortController = new AbortController();
    const stopWhenPartial = provider.subscribe(context, ({ viewData }) => {
      if (viewData.drawing && viewData.playback) abortController.abort();
    });
    try {
      await assert.rejects(draw.execute({ nodes: [{ id: 'step', label: '下一步' }] },
        { conversationId: 17 }, { abortSignal: abortController.signal }), { name: 'AbortError' });
    } finally {
      stopWhenPartial();
    }
    assert.deepEqual(provider.read(context).viewData, edited);
    await assert.rejects(draw.execute({ ...sceneArgs, mode: 'replace' }, { conversationId: 17 }), /revision/);
  } finally {
    dispose();
  }
});

test('all six layouts produce native nodes and separate reciprocal and self-loop connections', () => {
  for (const layout of ['architecture', 'dependency', 'flow', 'state', 'network', 'mindmap']) {
    const groups = planDiagram({
      ...sceneArgs, layout, edges: [...sceneArgs.edges, { from: 'b', to: 'b' }],
    }, []);
    const elements = normalizeCanvasScene({ elements: groups.flat() }).elements;
    const arrows = elements.filter(element => element.type === 'arrow');
    assert.equal(arrows.length, 3, layout);
    assert.equal(arrows[0].points.length, 3, layout);
    assert.equal(arrows[1].points.length, 3, layout);
    assert.equal(arrows[2].points.length, 5, layout);
  }
});

test('the plugin scene validator rejects active embeds, non-local images, and duplicate IDs', () => {
  const shape = { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, link: 'https://example.test' };
  assert.deepEqual(normalizeCanvasScene({ elements: [shape] }).elements[0], {
    id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50,
  });
  assert.throws(() => normalizeCanvasScene({ elements: [{ ...shape, type: 'embeddable' }] }), /不支持的元素类型/);
  assert.throws(() => normalizeCanvasScene({
    elements: [{ ...shape, type: 'image', fileId: 'image' }],
    files: { image: { dataURL: 'https://example.test/image.png' } },
  }), /内嵌/);
  assert.throws(() => normalizeCanvasScene({ elements: [shape, shape] }), /重复 ID/);
});

test('excalidraw_draw waits for a newly revealed sidebar subscriber before starting playback timing', async t => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'studio-board-delay-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const snapshots = [];
  let subscribedAt = 0;
  let dispose;
  let activated;
  activated = activate({
    dataDirectory,
    revealPanel(_panelId, id) {
      setTimeout(() => {
        subscribedAt = Date.now();
        dispose = activated.dataSources.scene.subscribe({ durableSessionId: String(id) }, value => {
          snapshots.push(value.viewData);
        });
      }, 120);
    },
  });
  const [draw] = activated.durableExtension.tools;
  try {
    await draw.execute(sceneArgs, { conversationId: 23 });
    assert.ok(subscribedAt > 0, 'revealPanel should attach a subscriber');
    const animated = snapshots.find(snapshot => snapshot.drawing && snapshot.playback);
    assert.ok(animated, 'newly revealed subscriber must receive the animated playback state');
    assert.ok(animated.playback.startAt >= subscribedAt, 'playback should begin after sidebar subscribes');
  } finally {
    dispose?.();
  }
});

test('excalidraw plugin manages multiple independent boards per conversation and migrates legacy single-file scenes', async t => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'studio-multiboard-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  await mkdir(path.join(dataDirectory, 'sessions'), { recursive: true });
  await writeFile(
    path.join(dataDirectory, 'sessions', '31.excalidraw.json'),
    JSON.stringify({
      revision: 3,
      drawing: false,
      title: '旧版架构图',
      scene: {
        elements: [{ id: 'legacy-1', type: 'rectangle', x: 10, y: 20, width: 120, height: 60 }],
        files: {},
      },
    }),
    'utf8',
  );

  const activated = activate({ dataDirectory });
  const [draw, read] = activated.durableExtension.tools;
  const provider = activated.dataSources.scene;
  const context = { durableSessionId: '31' };

  // Legacy single-board session loads transparently as default board
  const initial = provider.read(context).viewData;
  assert.equal(initial.boardId, 'default');
  assert.equal(initial.activeBoardId, 'default');
  assert.equal(initial.revision, 3);
  assert.equal(initial.title, '旧版架构图');
  assert.equal(initial.boards.length, 1);

  // Drawing a differently titled standalone diagram auto-creates a second board
  await draw.execute({
    title: '启动主流程',
    nodes: [{ id: 's1', label: '入口' }],
  }, { conversationId: 31 });
  const afterSecond = provider.read(context).viewData;
  assert.equal(afterSecond.boards.length, 2);
  assert.notEqual(afterSecond.boardId, 'default');
  assert.equal(afterSecond.title, '启动主流程');

  // Legacy default board remained untouched
  const legacyCheck = JSON.parse((await read.execute({ boardId: 'default' }, { conversationId: 31 })).output[0].text);
  assert.equal(legacyCheck.title, '旧版架构图');
  assert.equal(legacyCheck.nodes[0].id, 'legacy-1');
  assert.equal(legacyCheck.boards.length, 2);

  // Explicit mode: "new" creates a third board, UI methods switch, rename, and delete cleanly
  const manual = provider.invoke(context, 'createBoard', { title: '手动草稿' });
  assert.equal(manual.boards.length, 3);
  assert.equal(manual.title, '手动草稿');

  const renamed = provider.invoke(context, 'renameBoard', { boardId: manual.boardId, title: '部署拓扑' });
  assert.equal(renamed.title, '部署拓扑');

  await draw.execute({
    boardId: manual.boardId,
    mode: 'append',
    nodes: [{ id: 'k8s', label: 'Ingress' }],
  }, { conversationId: 31 });
  const updatedManual = provider.read(context).viewData;
  assert.equal(updatedManual.boardId, manual.boardId);
  assert.equal(updatedManual.scene.elements.length, 2);

  const selectedLegacy = provider.invoke(context, 'selectBoard', { boardId: 'default' });
  assert.equal(selectedLegacy.boardId, 'default');
  assert.equal(selectedLegacy.title, '旧版架构图');

  const afterDelete = provider.invoke(context, 'deleteBoard', { boardId: manual.boardId });
  assert.equal(afterDelete.boards.length, 2);
  assert.equal(afterDelete.boardId, 'default');

  // Explicit mode: "new" with custom boardId
  await draw.execute({
    boardId: 'refresh-flow',
    mode: 'new',
    title: 'refresh 详解',
    nodes: [{ id: 'r1', label: 'prepareRefresh' }],
  }, { conversationId: 31 });
  const withCustom = provider.read(context).viewData;
  assert.equal(withCustom.boardId, 'refresh-flow');
  assert.equal(withCustom.boards.length, 3);
});
