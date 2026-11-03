/**
 * The conversation outline uses a small, representative set of ticks when a
 * session has many questions. Sampling keeps the rail inside its fixed viewport
 * without taking navigation away from the conversation.
 */
export const OUTLINE_MAX_SAMPLES = 12;

/**
 * Return sorted, real question indexes. The first and last questions are always
 * represented, and the active question replaces its nearest sampled neighbor.
 *
 * @param {number} length
 * @param {number} activeIndex
 * @param {number} maxSamples
 * @returns {number[]}
 */
export function sampleOutlineIndices(length, activeIndex, maxSamples = OUTLINE_MAX_SAMPLES) {
  const itemCount = Math.max(0, Math.floor(Number(length) || 0));
  if (itemCount === 0) return [];

  const requestedCount = Math.floor(Number(maxSamples) || OUTLINE_MAX_SAMPLES);
  const sampleCount = Math.min(itemCount, Math.max(1, requestedCount));
  if (sampleCount === itemCount) return Array.from({ length: itemCount }, (_, index) => index);
  if (sampleCount === 1) return [0];
  if (sampleCount === 2) return [0, itemCount - 1];

  const samples = Array.from({ length: sampleCount }, (_, index) =>
    Math.round((index * (itemCount - 1)) / (sampleCount - 1)));
  const current = Math.min(itemCount - 1, Math.max(0, Math.floor(Number(activeIndex) || 0)));
  if (samples.includes(current)) return samples;

  let nearestPosition = 1;
  for (let index = 2; index < samples.length - 1; index += 1) {
    if (Math.abs(samples[index] - current) < Math.abs(samples[nearestPosition] - current)) {
      nearestPosition = index;
    }
  }
  samples[nearestPosition] = current;
  return samples.sort((left, right) => left - right);
}
