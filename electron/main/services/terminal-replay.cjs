/**
 * Bounded terminal output with the geometry changes needed to replay it.
 * A truncated journal is only recent output: ANSI parser state, cursor state,
 * and screen contents preceding its retained prefix cannot be reconstructed.
 */
const CHUNK_MERGE_CHARS = 4_096;

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
    if (step.type === 'data') charCount -= step.length;
    else {
      initialCols = step.cols;
      initialRows = step.rows;
    }
    truncated = true;
  }

  function trimLeadingLowSurrogate(step) {
    const head = step.chunks[0];
    if (!head) return;
    const code = head.charCodeAt(0);
    if (code < 0xdc00 || code > 0xdfff) return;
    const rest = head.slice(1);
    step.length -= 1;
    charCount -= 1;
    if (rest) step.chunks[0] = rest;
    else step.chunks.shift();
  }

  function trim() {
    while (steps.length > maxSteps) removeFirst();
    while (charCount > maxChars) {
      const first = steps[0];
      if (first.type === 'resize' || first.length <= charCount - maxChars) {
        removeFirst();
        continue;
      }
      let excess = charCount - maxChars;
      while (first.chunks.length > 0 && first.chunks[0].length <= excess) {
        const dropped = first.chunks.shift();
        first.length -= dropped.length;
        charCount -= dropped.length;
        excess -= dropped.length;
        truncated = true;
        if (excess === 0 && dropped.length > 0) {
          const lastCode = dropped.charCodeAt(dropped.length - 1);
          if (lastCode >= 0xd800 && lastCode <= 0xdbff) trimLeadingLowSurrogate(first);
        }
      }
      if (excess > 0 && first.chunks.length > 0) {
        let cut = excess;
        const head = first.chunks[0];
        // Do not create an orphan low surrogate at a newly clipped boundary.
        const before = head.charCodeAt(cut - 1);
        const after = head.charCodeAt(cut);
        if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) cut++;
        const nextHead = head.slice(cut);
        first.length -= cut;
        charCount -= cut;
        truncated = true;
        if (nextHead) first.chunks[0] = nextHead;
        else {
          first.chunks.shift();
          if (before >= 0xd800 && before <= 0xdbff && cut === head.length) trimLeadingLowSurrogate(first);
        }
      }
      if (first.chunks.length === 0) steps.shift();
    }
  }

  return {
    append(data) {
      if (typeof data !== 'string') throw new TypeError('Terminal replay data must be a string');
      if (!data) return;
      const previous = steps.at(-1);
      if (previous?.type === 'data') {
        const lastIndex = previous.chunks.length - 1;
        if (lastIndex >= 0 && previous.chunks[lastIndex].length + data.length <= CHUNK_MERGE_CHARS) {
          previous.chunks[lastIndex] += data;
        } else {
          previous.chunks.push(data);
        }
        previous.length += data.length;
      } else {
        steps.push({ type: 'data', chunks: [data], length: data.length });
      }
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
        steps: steps.map(step => (
          step.type === 'data'
            ? { type: 'data', data: step.chunks.length === 1 ? step.chunks[0] : step.chunks.join('') }
            : { ...step }
        )),
        truncated,
      };
    },
  };
}

module.exports = { createTerminalReplay };
