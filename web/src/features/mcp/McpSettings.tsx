import { ChevronRight, Pencil, Plug, Plus, Trash2 } from 'lucide-react';
import { InfoHint } from '../../shared/InfoHint';
import { EmptyStateArt } from '../../shared/EmptyStateArt';
import { StatusGlyph } from '../../shared/StatusGlyph';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { mcpConnectionStatus } from './mcp-status';
import './mcp-settings.css';

export type McpSettingsServer = {
  name: string;
  transport: string;
  enabled: boolean;
  connected: boolean;
  target: string;
  description: string;
  exposure: 'direct' | 'deferred' | 'hidden';
  toolCount: number;
  error: string;
};

export function McpSettings<T extends McpSettingsServer>({ servers, busy, recoveryPending = false, refreshBusy = false, onAdd, onRefresh, onOpen, onEdit, onToggle, onDelete }: {
  servers: readonly T[];
  busy: boolean;
  recoveryPending?: boolean;
  refreshBusy?: boolean;
  onAdd: () => void;
  onRefresh: () => void;
  onOpen: (server: T) => void;
  onEdit: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => void;
  onDelete: (name: string) => void;
}) {
  return <div className="settings-sections mcp-settings">
    <SettingsPageHeader icon={<Plug />} title="MCP 服务器"
      meta={servers.length ? <><span>{servers.length} 个服务器</span><InfoHint label="默认通过 tool_search 按需发现工具；连接变更从下一次请求开始生效。" /></> : undefined}
      actions={<>
        <button type="button" className="settings-outline" disabled={busy || refreshBusy || recoveryPending} aria-label="刷新 MCP 服务器状态" onClick={onRefresh}><span className={`mcp-refresh-glyph ${refreshBusy ? 'spin' : ''}`} aria-hidden="true">↻</span>{refreshBusy ? '正在刷新…' : '刷新状态'}</button>
        <button type="button" className="settings-add-button" disabled={busy || refreshBusy} aria-label="添加 MCP 服务器" onClick={onAdd}><Plus />添加服务器</button>
      </>} />
    {servers.length ? <ul className="mcp-server-list" aria-label="MCP 服务器">
      {servers.map(server => {
        const status = mcpConnectionStatus(server);
        return <li className="mcp-server-row" data-state={status.state} key={server.name}>
          <div className="mcp-server-copy">
            <button type="button" className="mcp-server-open" aria-label={`查看 MCP ${server.name} 详情`} onClick={() => onOpen(server)}>
              <strong>{server.name}</strong><ChevronRight aria-hidden="true" />
            </button>
            {server.description && <p className="mcp-server-description">{server.description}</p>}
            <code className="mcp-server-target" title={server.target}>{server.target}</code>
            <div className="mcp-server-meta">
              <span>{server.transport === 'stdio' ? '本地进程' : 'HTTP 服务'}</span>
              <span>{server.exposure === 'deferred' ? '按需搜索' : server.exposure === 'direct' ? '直接提供' : '隐藏工具'}</span>
              <span className="mcp-server-state"><StatusGlyph state={status.state === 'connected' ? 'on' : status.state === 'error' ? 'attention' : 'off'} />{status.label}</span>
            </div>
            {server.error.trim() && <details className="mcp-server-error">
              <summary>{server.enabled ? '查看错误' : '查看上次连接错误'}</summary>
              <pre tabIndex={0}>{server.error}</pre>
            </details>}
          </div>
          <div className="mcp-server-actions">
            <button type="button" className={`switch ${server.enabled ? 'is-on' : ''}`} role="switch" aria-checked={server.enabled}
              disabled={busy || recoveryPending} onClick={() => onToggle(server.name, !server.enabled)} aria-label={`${server.name} ${server.enabled ? '禁用' : '启用'}`}><span /></button>
            <button type="button" className="icon-button" disabled={busy} aria-label={`编辑 ${server.name}`} title="编辑" onClick={() => onEdit(server.name)}><Pencil /></button>
            <button type="button" className="icon-button" data-destructive="true" disabled={busy || recoveryPending} aria-label={`删除 MCP ${server.name}`} title="删除" onClick={() => onDelete(server.name)}><Trash2 /></button>
          </div>
        </li>;
      })}
    </ul> : <div className="mcp-settings-empty">
      <EmptyStateArt />
      <p>还没有 MCP 服务器</p>
      <span>添加后，服务器提供的工具会出现在智能体工具调用里。</span>
    </div>}
  </div>;
}
