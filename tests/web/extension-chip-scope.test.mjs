import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function compile(relative) {
  const context = { exports: {}, require };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.exports;
}

const { scopedExtensionChips } = compile('../../web/src/features/extensions/extension-chip-scope.ts');

test('status chips only exist inside a real session', () => {
  const chips = [{ item: { id: 'a' }, targetId: 'b' }];
  // vm 里创建的数组原型与主上下文不同，按长度与元素断言。
  assert.equal(scopedExtensionChips('session-1', chips).length, 1, '会话内保留扩展声明的 chip');
  assert.equal(scopedExtensionChips('session-1', chips)[0], chips[0]);
  assert.equal(scopedExtensionChips(undefined, chips).length, 0, '新会话草稿态不渲染 chip');
  assert.equal(scopedExtensionChips('', chips).length, 0, '空 sessionId 视同草稿态');
});
