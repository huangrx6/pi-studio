import assert from 'node:assert/strict';
import test from 'node:test';

import { errorText } from '../../web/src/shared/error-text.ts';

test('electron IPC wrappers are stripped down to the real reason', () => {
  assert.equal(
    errorText(new Error("Error invoking remote method 'pi:turn-diff-absolute-file': Error: 文件不存在或无法访问")),
    '文件不存在或无法访问',
  );
  assert.equal(
    errorText(new Error("Error invoking remote method 'pi:usage-summary': TypeError: boom")),
    'boom',
  );
  // 没有包装的错误原样保留。
  assert.equal(errorText(new Error('模型来源不存在')), '模型来源不存在');
  assert.equal(errorText('直接给出的字符串'), '直接给出的字符串');
});

test('empty or non-error inputs still produce readable text', () => {
  assert.equal(errorText(undefined), '操作未完成');
  assert.equal(errorText(null), '操作未完成');
  assert.equal(errorText(new Error('')), '操作未完成');
});
