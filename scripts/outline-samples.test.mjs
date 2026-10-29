import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OUTLINE_MAX_SAMPLES,
  sampleOutlineIndices,
} from '../web/src/outline-samples.mjs';

test('short transcripts keep every real question in the outline', () => {
  assert.deepEqual(sampleOutlineIndices(0, 0), []);
  assert.deepEqual(sampleOutlineIndices(5, 3), [0, 1, 2, 3, 4]);
});

test('long transcripts use a bounded evenly distributed outline', () => {
  const samples = sampleOutlineIndices(450, 0);
  assert.equal(samples.length, OUTLINE_MAX_SAMPLES);
  assert.equal(samples[0], 0);
  assert.equal(samples.at(-1), 449);
  assert.deepEqual(samples, [...new Set(samples)].sort((left, right) => left - right));
  assert.ok(samples.every((value, index) => index === 0 || value - samples[index - 1] >= 35));
});

test('the active question stays addressable without growing the outline', () => {
  const samples = sampleOutlineIndices(450, 224);
  assert.equal(samples.length, OUTLINE_MAX_SAMPLES);
  assert.ok(samples.includes(224));
  assert.equal(samples[0], 0);
  assert.equal(samples.at(-1), 449);
});

test('very small sample limits still preserve the chronological bounds', () => {
  assert.deepEqual(sampleOutlineIndices(10, 5, 1), [0]);
  assert.deepEqual(sampleOutlineIndices(10, 5, 2), [0, 9]);
});
