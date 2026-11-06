export function mcpConnectionStatus(server: { enabled: boolean; connected: boolean; error: string; toolCount: number }) {
  if (!server.enabled) return { state: 'disabled', label: '已停用' } as const;
  if (server.error.trim()) return { state: 'error', label: '连接异常' } as const;
  if (!server.connected) return { state: 'waiting', label: '等待连接' } as const;
  const count = Number.isFinite(server.toolCount) ? Math.max(0, Math.floor(server.toolCount)) : 0;
  return { state: 'connected', label: `已连接 · ${count} 个工具` } as const;
}
