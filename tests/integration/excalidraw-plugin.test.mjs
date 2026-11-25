import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activate } from '../../assets/official-plugins/packages/excalidraw/extension/extension.mjs';
import { planDiagram } from '../../assets/official-plugins/packages/excalidraw/extension/diagram.mjs';
import canvas from '../../electron/main/services/extension-canvas.cjs';

const sceneArgs = {
  title: '审阅',
  nodes: [{ id: 'a', label: '草案' }, { id: 'b', label: '评审', shape: 'diamond' }],
  edges: [{ from: 'a', to: 'b', label: '确认' }, { from: 'b', to: 'a', dashed: true }],
};

test('the plugin publishes real intermediate scenes and saves only the completed drawing for its conversation', async t => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'studio-board-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const revealed = [];
  const activated = activate({ dataDirectory, canvasVersion: 1, revealPanel: (...event) => revealed.push(event) });
  const [draw, read] = activated.durableExtension.tools;
  const provider = activated.dataSources.scene;
  const context = { durableSessionId: '17' };
  const snapshots = [];
  const dispose = provider.subscribe(context, value => snapshots.push(canvas.normalizeCanvasSnapshot(value.canvas)));
  try {
    await draw.execute(sceneArgs, { conversationId: 17 });
    assert.deepEqual(revealed, [['board', 17]]);
    const counts = snapshots.filter(snapshot => snapshot.drawing).map(snapshot => snapshot.scene.elements.length);
    assert.deepEqual(counts, [0, 2, 4, 6, 7]);
    const final = provider.read(context).canvas;
    assert.equal(final.revision, 1);
    assert.equal(final.drawing, false);
    assert.equal(final.scene.elements.length, 7);
    assert.equal(provider.read({ durableSessionId: '18' }).canvas.scene.elements.length, 0);
    const details = JSON.parse((await read.execute({}, { conversationId: 17 })).output[0].text);
    assert.equal(details.nodes[1].label, '评审');
    assert.equal(details.edges[1].to, 'a');
    assert.throws(() => provider.writeCanvas(context, { revision: 0, scene: final.scene }), /读取最新版本/);
    const edited = provider.writeCanvas(context, { revision: 1, scene: { ...final.scene, elements: final.scene.elements.slice(0, 2) } });
    assert.equal(edited.revision, 2);

    const abortController = new AbortController();
    const stopWhenPartial = provider.subscribe(context, ({ canvas }) => {
      if (canvas.drawing && canvas.scene.elements.length > 2) abortController.abort();
    });
    try {
      await assert.rejects(draw.execute({ nodes: [{ id: 'step', label: '下一步' }] },
        { conversationId: 17 }, { abortSignal: abortController.signal }), { name: 'AbortError' });
    } finally {
      stopWhenPartial();
    }
    assert.deepEqual(provider.read(context).canvas, edited);
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
    const elements = canvas.normalizeCanvasScene({ elements: groups.flat() }).elements;
    const arrows = elements.filter(element => element.type === 'arrow');
    assert.equal(arrows.length, 3, layout);
    assert.equal(arrows[0].points.length, 3, layout);
    assert.equal(arrows[1].points.length, 3, layout);
    assert.equal(arrows[2].points.length, 5, layout);
  }
});

test('stopping a live drawing restores the previous canvas and never saves its playback target', async t => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'studio-board-playback-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const active = activate({
    dataDirectory, canvasVersion: 1, canvasPlaybackVersion: 1, normalizeCanvasScene: canvas.normalizeCanvasScene,
  });
  const provider = active.dataSources.scene;
  const [draw] = active.durableExtension.tools;
  const context = { durableSessionId: '24' };
  const original = canvas.normalizeCanvasScene({ elements: planDiagram({ ...sceneArgs, edges: [] }, []).flat() });
  provider.writeCanvas(context, { revision: 0, scene: original });
  const abort = new AbortController();
  let playback;
  const unsubscribe = provider.subscribe(context, ({ canvas: board }) => {
    if (!board.playback) return;
    playback = canvas.normalizeCanvasSnapshot(board);
    abort.abort();
  });
  try {
    await assert.rejects(draw.execute({ nodes: [{ id: 'new', label: '新节点' }] },
      { conversationId: 24 }, { abortSignal: abort.signal }), { name: 'AbortError' });
    assert.equal(playback.playback.firstElement, original.elements.length);
    assert.equal(playback.scene.elements.length, original.elements.length + 2);
    const restored = provider.read(context).canvas;
    assert.equal(restored.revision, 1);
    assert.deepEqual(restored.scene, original);
    assert.equal(restored.drawing, false);
  } finally {
    unsubscribe();
  }
});

test('the renderer contract accepts drawing data and rejects active embeds and non-local images', () => {
  const shape = { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, link: 'https://example.test' };
  assert.deepEqual(canvas.normalizeCanvasScene({ elements: [shape] }).elements[0], {
    id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50,
  });
  assert.throws(() => canvas.normalizeCanvasScene({ elements: [{ ...shape, type: 'embeddable' }] }), /不支持的元素类型/);
  assert.throws(() => canvas.normalizeCanvasScene({
    elements: [{ ...shape, type: 'image', fileId: 'image' }],
    files: { image: { dataURL: 'https://example.test/image.png' } },
  }), /内嵌/);
  assert.throws(() => canvas.normalizeCanvasScene({ elements: [shape, shape] }), /重复 ID/);
});
