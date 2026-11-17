import test from 'node:test';
import assert from 'node:assert/strict';
import { filmTimeline, posterFrame } from '../../web/src/features/video-storyboard/film/timeline.ts';
import { drawCallout } from '../../web/src/features/video-storyboard/film/callout.ts';

test('film uses the selected plan, rounds cumulative time and aligns each clip to its picture slot', () => {
  const doc = {
    aspect: '16:9', plans: [{ id: 'a', nodeId: 'review' }], nodes: [{ id: 'review', step: { brief: { aspect: '9:16' } } }],
    assets: [{ id: 'photo', kind: 'image' }, { id: 'movie', kind: 'video' }, { id: 'voice', kind: 'audio' }],
    shots: [
      { id: '1', planId: 'a', durationMs: 1050, assetIds: ['photo', 'movie', 'voice'], composition: { volume: .5 } },
      { id: 'old', planId: 'b', durationMs: 1000, assetIds: [] },
      { id: '2', planId: 'a', durationMs: 1050, assetIds: ['movie'], composition: { volume: 0 } },
    ],
    tracks: [{ clips: [{ shotId: '1', assetId: 'voice', offsetMs: 100, durationMs: 500, gainDb: 0 }] }],
  };
  const film = filmTimeline(doc, 'a');
  assert.deepEqual([film.width, film.height, film.frames], [720, 1280, 63]);
  assert.deepEqual(film.scenes.map(s => [s.first, s.frames]), [[0, 32], [32, 31]]);
  assert.deepEqual(film.scenes[0].sounds, [
    { assetId: 'voice', from: .1, until: .6, gain: .5 },
    { assetId: 'movie', from: 16 / 30, until: 32 / 30, gain: .5 },
  ]);
  assert.deepEqual(film.scenes[1].sounds, []);
  doc.shots[0].composition.mutedAudioIds = ['voice'];
  assert.deepEqual(filmTimeline(doc, 'a').scenes[0].sounds.map(clip => clip.assetId), ['movie']);
});

test('callout uses final frame coordinates, fades on both edges and exposes its label in the poster', () => {
  const box = { x: .7, y: 0, width: .25, height: .2, startMs: 1000, endMs: 2000, label: '网页来源' };
  const shape = time => {
    const rects = [], texts = [], strokes = [];
    const ctx = { canvas: { width: 720, height: 1280 }, globalAlpha: 1,
      save() {}, restore() {}, beginPath() {}, roundRect(...values) { rects.push(values); },
      measureText() { return { width: 500 }; }, fill() {}, stroke() { strokes.push(this.globalAlpha); }, fillText(...values) { texts.push(values); } };
    drawCallout(ctx, box, time);
    return { rects, texts, strokes };
  };
  assert.equal(shape(999).rects.length, 0);
  assert.equal(shape(2000).rects.length, 0);
  const { rects, texts } = shape(1500);
  assert.deepEqual(rects[0], [box.x * 720, 0, 180, 256, 10]);
  assert.ok(rects[1][0] + rects[1][2] <= 720 && rects[1][1] > 0);
  assert.equal(texts[0][0], box.label);
  assert.deepEqual([1080, 1500, 1920].map(t => shape(t).strokes[0]), [.5, 1, .5]);
  const scene = { frames: 90, shot: { composition: { callout: box, pointer: { atMs: 180 } }, captions: [] } };
  const posterMs = posterFrame(scene) * 1000 / 30;
  assert.equal(shape(posterMs).strokes[0], 1);
  scene.shot.composition.pointer.atMs = 1250;
  assert.equal(posterFrame(scene), Math.ceil(1250 * 30 / 1000) + 2);
});
