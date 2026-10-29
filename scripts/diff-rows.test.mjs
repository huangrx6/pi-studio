import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitPatch, changedRange } from '../web/src/diff-rows.ts';
test('split diffs pair replacements, leave unmatched rows blank and preserve hunk numbers', () => {
  const rows=splitPatch('--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +10,4 @@\n same\n-old\n+new\n+extra\n tail\n@@ -20 +21 @@\n-x\n+y\n\\ No newline at end of file\n');
  assert.equal(rows[0].gap,'省略 9 行未改动内容');
  assert.equal(rows[2].left.text,'old'); assert.equal(rows[2].right.text,'new');
  assert.equal(rows[3].left,undefined); assert.equal(rows[3].right.number,12);
  assert.equal(rows[4].left.number,12); assert.equal(rows[4].right.number,13);
  assert.equal(rows[5].gap,'省略 7 行未改动内容');
  assert.equal(rows[6].right.number,21);
});
test('added/deleted files, prefix-like contents and word changes keep actual text', () => {
  assert.equal(splitPatch('@@ -0,0 +1,1 @@\n+++literal')[0].right.text,'++literal');
  assert.equal(splitPatch('@@ -1,1 +0,0 @@\n---literal')[0].left.text,'--literal');
  assert.deepEqual(changedRange('const x = 20;', 'const x = 10;'),[10,11]);
  assert.equal(changedRange('same','same'),null);
  assert.equal(changedRange('new'),null);
  assert.deepEqual(splitPatch('Binary files a and b differ'),[]);
});
