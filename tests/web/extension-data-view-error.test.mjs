import assert from 'node:assert/strict';
import test from 'node:test';

import { presentExtensionDataViewError } from '../../web/src/lib/extension-data-view-error.ts';

test('IPC timeout messages become concise connection guidance', () => {
  assert.deepEqual(
    presentExtensionDataViewError(
      new Error("Error invoking remote method 'pi:extension-data-view-open': ExtensionDataViewError: 实时数据源读取超时"),
    ),
    {
      title: '连接超时',
      message: '实时数据暂时没有响应。检查网络后重试。',
    },
  );
});

test('network errors are separated from extension permission failures', () => {
  assert.equal(
    presentExtensionDataViewError(new Error('fetch failed: ECONNRESET')).title,
    '网络连接不稳定',
  );
  assert.equal(
    presentExtensionDataViewError(new Error('extension ui.data permission forbidden')).title,
    '扩展权限不足',
  );
});

test('unknown internal errors are not exposed to the renderer copy', () => {
  const result = presentExtensionDataViewError(new Error('TypeError: private internal detail'));
  assert.deepEqual(result, {
    title: '实时数据暂不可用',
    message: '请稍后重新连接。',
  });
  assert.doesNotMatch(`${result.title} ${result.message}`, /private internal detail|TypeError/);
});
