import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  automaticTokenUnit,
  convertTokenInput,
  tokenInputAsInteger,
  tokenInputValue,
  tokenLabel,
  tokenUnitOptions,
} from '../../web/src/lib/token-units.ts';

test('token labels promote 1000K to 1M and stay compact', () => {
  assert.equal(tokenLabel(999), '999');
  assert.equal(tokenLabel(1_000), '1K');
  assert.equal(tokenLabel(8_192), '8.19K');
  assert.equal(tokenLabel(131_072), '131K');
  assert.equal(tokenLabel(1_000_000), '1M');
  assert.equal(tokenLabel(1_048_576), '1.05M');
});

test('token editor chooses readable units and preserves exact integers', () => {
  assert.equal(automaticTokenUnit(999), 'tokens');
  assert.equal(automaticTokenUnit(1_000), 'k');
  assert.equal(automaticTokenUnit(1_000_000), 'm');
  assert.equal(automaticTokenUnit(1_000_000_000), 'b');
  assert.equal(automaticTokenUnit(1_000_000_000_000), 't');
  assert.equal(tokenInputValue(1_000_000, 'm'), '1');
  assert.equal(tokenInputAsInteger('1', 'm'), 1_000_000);
  assert.equal(tokenInputAsInteger('1', 't'), 1_000_000_000_000);
  assert.equal(convertTokenInput('1.5', 'm', 'k'), '1500');
});

test('token units expose the complete Tokens through T scale', () => {
  assert.deepEqual(
    tokenUnitOptions.map((option) => option.value),
    ['tokens', 'k', 'm', 'b', 't'],
  );
  assert.equal(tokenInputAsInteger('0', 'k'), undefined);
  assert.equal(tokenInputAsInteger('10000', 't'), undefined);
});
