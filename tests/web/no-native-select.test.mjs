import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const webSource = fileURLToPath(new URL('../../web/src/', import.meta.url));

async function typescriptSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await typescriptSources(target));
    else if (entry.isFile() && entry.name.endsWith('.tsx')) files.push(target);
  }
  return files;
}

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('web UI uses shared Select and DatePicker components instead of native popups', async () => {
  const files = await typescriptSources(webSource);
  const violations = [];
  for (const file of files) {
    const source = withoutComments(await readFile(file, 'utf8'));
    if (/<select(?:\s|>)/.test(source)) violations.push(path.relative(webSource, file));
    if (/<input\b[^>]*\btype\s*=\s*["']date["']/i.test(source)) {
      violations.push(`${path.relative(webSource, file)} (native date input)`);
    }
  }
  assert.deepEqual(violations, []);
});
