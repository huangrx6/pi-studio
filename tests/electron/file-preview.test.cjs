const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_TEXT_BYTES,
  readFilePreview,
} = require('../../electron/services/file-preview.cjs');

test('file preview returns bounded text and inlines allowlisted images', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-preview-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'SKILL.md'), '# Skill\n\nHello preview.');
  fs.writeFileSync(path.join(directory, 'preview.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  assert.deepEqual(
    readFilePreview(directory, 'SKILL.md'),
    {
      path: 'SKILL.md',
      name: 'SKILL.md',
      size: Buffer.byteLength('# Skill\n\nHello preview.'),
      mimeType: 'text/markdown',
      kind: 'text',
      text: '# Skill\n\nHello preview.',
      truncated: false,
    },
  );
  const image = readFilePreview(directory, 'preview.png');
  assert.equal(image.kind, 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.match(image.dataUrl, /^data:image\/png;base64,/);
});

test('file preview clips large text and rejects binary or escaped paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-preview-'));
  const directory = path.join(root, 'skill');
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'large.txt'), 'x'.repeat(MAX_TEXT_BYTES + 100));
  fs.writeFileSync(path.join(directory, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(directory, 'notes.custom'), 'Plain text with an unknown extension.');
  fs.writeFileSync(path.join(directory, 'guide.pdf'), '%PDF-1.7');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');

  const large = readFilePreview(directory, 'large.txt');
  assert.equal(large.truncated, true);
  assert.equal(large.text.length, MAX_TEXT_BYTES);
  const unknownBinary = readFilePreview(directory, 'asset.bin');
  assert.equal(unknownBinary.kind, 'binary');
  assert.equal(unknownBinary.unavailableReason, undefined);
  assert.equal(readFilePreview(directory, 'notes.custom').kind, 'text');
  // PDF 交给内置阅读器渲染，不再是“不支持”的二进制。
  const pdf = readFilePreview(directory, 'guide.pdf');
  assert.equal(pdf.kind, 'pdf');
  assert.equal(pdf.mimeType, 'application/pdf');
  assert.match(pdf.dataUrl, /^data:application\/pdf;base64,/);
  assert.equal(pdf.unavailableReason, undefined);
  assert.throws(() => readFilePreview(directory, '../outside.txt'), /outside workspace/);
});
