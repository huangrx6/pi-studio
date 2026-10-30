import assert from 'node:assert/strict';
import test from 'node:test';
import { safeMarkdownImageSource } from '../../web/src/lib/safe-url.js';

test('Markdown images allow only intended image protocols', () => {
  assert.equal(
    safeMarkdownImageSource('https://images.example/a.png'),
    'https://images.example/a.png',
  );
  assert.equal(
    safeMarkdownImageSource('pi-media://background/example.png'),
    'pi-media://background/example.png',
  );
  assert.match(
    safeMarkdownImageSource('data:image/png;base64,iVBORw0KGgo='),
    /^data:image\/png;base64,/,
  );
});

test('Markdown images reject local files, scripts, SVG data, and credentials', () => {
  for (const value of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'https://user:secret@example.com/a.png',
    '../secret.png',
    '',
  ]) {
    assert.equal(safeMarkdownImageSource(value), '', value);
  }
});
