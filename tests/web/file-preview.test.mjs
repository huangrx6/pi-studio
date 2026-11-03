import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markdownCodeFence,
  parseDelimitedPreview,
  prettyJson,
  previewFormatForFile,
  previewLanguageForFile,
  splitPreviewPath,
} from '../../web/src/shared/file-preview.mjs';

test('file preview formats map extensions before textual fallbacks', () => {
  assert.equal(previewFormatForFile('SKILL.md', 'text/markdown', 'text'), 'markdown');
  assert.equal(previewFormatForFile('config.json', 'application/json', 'text'), 'json');
  assert.equal(previewFormatForFile('items.tsv', 'text/tab-separated-values', 'text'), 'csv');
  assert.equal(previewFormatForFile('preview.svg', 'image/svg+xml', 'image'), 'image');
  assert.equal(previewFormatForFile('report.pdf', 'application/pdf', 'binary'), 'unsupported');
  assert.equal(previewFormatForFile('scripts/check.ts', 'text/typescript', 'text'), 'code');
  assert.equal(previewFormatForFile('notes.txt', 'text/plain', 'text'), 'text');
  assert.equal(previewLanguageForFile('scripts/check.mjs'), 'javascript');
  assert.equal(previewLanguageForFile('Dockerfile'), 'dockerfile');
});

test('JSON preview formats valid input and preserves invalid source with an error', () => {
  assert.deepEqual(prettyJson('{"ok":true,"count":2}'), {
    ok: true,
    text: '{\n  "ok": true,\n  "count": 2\n}',
    error: '',
  });
  const invalid = prettyJson('{broken');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.text, '{broken');
  assert.ok(invalid.error);
});

test('CSV preview handles quotes, escaped quotes, embedded newlines and row limits', () => {
  const parsed = parseDelimitedPreview(
    'name,note\r\nAlpha,"first, quoted"\r\nBeta,"line one\nline ""two"""',
  );
  assert.deepEqual(parsed.headers, ['name', 'note']);
  assert.deepEqual(parsed.rows, [
    ['Alpha', 'first, quoted'],
    ['Beta', 'line one\nline "two"'],
  ]);
  assert.equal(parsed.totalRows, 2);
  assert.equal(parsed.clippedRows, false);

  const clipped = parseDelimitedPreview('a,b\n1,2\n3,4\n5,6', ',', { maxRows: 2 });
  assert.deepEqual(clipped.rows, [['1', '2'], ['3', '4']]);
  assert.equal(clipped.totalRows, 3);
  assert.equal(clipped.clippedRows, true);
});

test('code fences grow beyond backtick runs and paths split into stable labels', () => {
  const fenced = markdownCodeFence('before ```` after', 'text');
  assert.match(fenced, /^`{5}text/m);
  assert.match(fenced, /`{5}$/);
  assert.deepEqual(splitPreviewPath('references/glossary.md'), {
    name: 'glossary.md',
    directory: 'references',
  });
});
