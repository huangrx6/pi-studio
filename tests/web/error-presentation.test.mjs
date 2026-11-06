import test from 'node:test';
import assert from 'node:assert/strict';
import { errorText } from '../../web/src/shared/error-text.ts';
import { conversationErrorPresentation } from '../../web/src/features/conversation/error-presentation.ts';

test('short errors display the actual reason once without IPC wrappers or unnecessary details', () => {
  assert.deepEqual(conversationErrorPresentation(errorText(new Error("Error invoking remote method 'pi:test': Error: 文件不存在"))), { summary: '文件不存在', details: null });
  assert.deepEqual(conversationErrorPresentation(''), { summary: '操作未完成', details: null });
});

test('multiline and long errors retain full cleaned information behind a compact summary', () => {
  assert.deepEqual(conversationErrorPresentation('连接中断\r\n  服务器暂时不可用'), { summary: '连接中断', details: '连接中断\r\n  服务器暂时不可用' });
  const long = '错误原因'.repeat(100);
  const result = conversationErrorPresentation(long);
  assert.equal(result.summary.length, 181);
  assert.equal(result.details, long);
  assert.equal(conversationErrorPresentation('第一行\n\n').details, null);
});
