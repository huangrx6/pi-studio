export type ExtensionDataViewErrorPresentation = {
  title: string;
  message: string;
};

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message || '');
  }
  return String(error || '');
}

export function presentExtensionDataViewError(error: unknown): ExtensionDataViewErrorPresentation {
  const message = errorText(error);

  if (/超时|timeout|timed\s*out|etimedout/i.test(message)) {
    return {
      title: '连接超时',
      message: '实时数据暂时没有响应。检查网络后重试。',
    };
  }
  if (/网络|network|fetch failed|econn|enotfound|enetunreach|socket|dns/i.test(message)) {
    return {
      title: '网络连接不稳定',
      message: '网络恢复后可重新连接实时数据。',
    };
  }
  if (/权限|forbidden|permission/i.test(message)) {
    return {
      title: '扩展权限不足',
      message: '请检查此扩展是否获得实时数据权限。',
    };
  }
  if (/数据源.*不可用|data_source_unavailable|not available/i.test(message)) {
    return {
      title: '数据源暂不可用',
      message: '此扩展当前无法提供实时数据。',
    };
  }
  return {
    title: '实时数据暂不可用',
    message: '请稍后重新连接。',
  };
}
