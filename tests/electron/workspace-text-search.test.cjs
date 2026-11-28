const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { searchFileContents } = require('../../electron/main/services/workspace-text-search.cjs');

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-text-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', '匹配.ts'), '🐳 说明：Tag Tagging tag\r\n中文标签 Tag\r\n');
  await fs.writeFile(path.join(root, 'log.txt'), 'Tag\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(root, 'ignored.txt'), 'Tag\n');
  return root;
}

test('workspace content search groups UTF-8 hits using original lines, word boundaries, case and globs', async t => {
  const cwd = await workspace(t);
  const all = await searchFileContents(cwd, 'tag');
  assert.equal(all.count, 5);
  const result = await searchFileContents(cwd, 'Ta[g]', { regex: true, wholeWord: true, caseSensitive: true, include: 'src/**/*.ts' });
  assert.equal(result.count, 2);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, path.join('src', '匹配.ts'));
  assert.deepEqual(result.files[0].rows.map(row => row.line), [1, 2]);
  assert.deepEqual(result.files[0].rows[0].parts, [{ text: '🐳 说明：' }, { text: 'Tag', match: true }, { text: ' Tagging tag' }]);
  assert.equal((await searchFileContents(cwd, 'Tag', { exclude: '**/*.ts' })).count, 1);
  assert.equal((await searchFileContents(cwd, 'Ta[g]')).count, 0);
  await assert.rejects(searchFileContents(cwd, '[', { regex: true }), /regex/i);
});

test('search distinguishes exactly the limit from incomplete results and honors cancellation', async t => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'bulk'), 'needle\n'.repeat(300));
  assert.equal((await searchFileContents(cwd, 'needle')).truncated, false);
  await fs.appendFile(path.join(cwd, 'bulk'), 'needle\n');
  const result = await searchFileContents(cwd, 'needle');
  assert.equal(result.count, 300);
  assert.equal(result.truncated, true);
  await assert.rejects(searchFileContents(cwd, 'needle', {}, AbortSignal.abort()), {name: 'AbortError'});
});
