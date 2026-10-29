import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LONG_MESSAGE_BYTES,
  LONG_MESSAGE_CHARS,
  LONG_MESSAGE_LINES,
  pasteExceedsBudget,
} from '../web/src/composer-budget.mjs';

test('an empty composer converts only an oversized pasted batch', () => {
  assert.equal(pasteExceedsBudget('', 'a'.repeat(LONG_MESSAGE_CHARS)), false);
  assert.equal(pasteExceedsBudget('', 'a'.repeat(LONG_MESSAGE_CHARS + 1)), true);
});

test('existing text consumes the shared budget without entering the pasted attachment', () => {
  const existing = 'a'.repeat(100);
  assert.equal(pasteExceedsBudget(existing, 'b'.repeat(LONG_MESSAGE_CHARS - existing.length)), false);
  assert.equal(pasteExceedsBudget(existing, 'b'.repeat(LONG_MESSAGE_CHARS - existing.length + 1)), true);
});

test('line and UTF-8 byte limits are checked in addition to character count', () => {
  assert.equal(pasteExceedsBudget('', 'line\n'.repeat(LONG_MESSAGE_LINES - 1)), false);
  assert.equal(pasteExceedsBudget('', 'line\n'.repeat(LONG_MESSAGE_LINES)), true);
  assert.equal(pasteExceedsBudget('', '鲸'.repeat(LONG_MESSAGE_BYTES / 3)), false);
  assert.equal(pasteExceedsBudget('', '鲸'.repeat(LONG_MESSAGE_BYTES / 3 + 1)), true);
});
