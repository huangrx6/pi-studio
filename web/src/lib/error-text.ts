/**
 * 统一的错误文案。
 *
 * 主进程通过 IPC 抛出的错误会被 Electron 包成
 * `Error invoking remote method 'pi:some-channel': Error: 真实信息`。
 * 界面只展示真实信息：通道名与包装语对用户没有意义，也会把内部接口名漏到界面上。
 */
const REMOTE_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/;

export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const stripped = raw.replace(REMOTE_WRAPPER, '').trim();
  return stripped || raw || '操作未完成';
}
