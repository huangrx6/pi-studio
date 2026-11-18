/**
 * Bounded terminal output with the geometry changes needed to replay it.
 * A truncated journal is only recent output: ANSI parser state, cursor state,
 * and screen contents preceding its retained prefix cannot be reconstructed.
 */
function createTerminalReplay({ cols, rows, maxChars = 1_000_000, maxSteps = 2048 }) {
  for (const [name, value] of Object.entries({ cols, rows, maxChars, maxSteps })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  let initialCols = cols;
  let initialRows = rows;
  let currentCols = cols;
  let currentRows = rows;
  let charCount = 0;
  let truncated = false;
  const steps = [];

  function removeFirst() {
    const step = steps.shift();
    if (step.type === 'data') charCount -= step.data.length;
    else {
      initialCols = step.cols;
      initialRows = step.rows;
    }
    truncated = true;
  }

  function trim() {
    while (steps.length > maxSteps) removeFirst();
    while (charCount > maxChars) {
      const first = steps[0];
      if (first.type === 'resize' || first.data.length <= charCount - maxChars) {
        removeFirst();
        continue;
      }
      let cut = charCount - maxChars;
      // Do not create an orphan low surrogate at a newly clipped boundary.
      const before = first.data.charCodeAt(cut - 1);
      const after = first.data.charCodeAt(cut);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) cut++;
      first.data = first.data.slice(cut);
      charCount -= cut;
      truncated = true;
      if (!first.data) steps.shift();
    }
  }

  return {
    append(data) {
      if (typeof data !== 'string') throw new TypeError('Terminal replay data must be a string');
      if (!data) return;
      const previous = steps.at(-1);
      if (previous?.type === 'data') previous.data += data;
      else steps.push({ type: 'data', data });
      charCount += data.length;
      trim();
    },
    resize(nextCols, nextRows) {
      if (!Number.isSafeInteger(nextCols) || nextCols < 1 || !Number.isSafeInteger(nextRows) || nextRows < 1) {
        throw new RangeError('Terminal replay dimensions must be positive integers');
      }
      if (nextCols === currentCols && nextRows === currentRows) return;
      currentCols = nextCols;
      currentRows = nextRows;
      steps.push({ type: 'resize', cols: nextCols, rows: nextRows });
      trim();
    },
    snapshot() {
      return {
        cols: initialCols,
        rows: initialRows,
        steps: steps.map(step => ({ ...step })),
        truncated,
      };
    },
  };
}

module.exports = { createTerminalReplay };
