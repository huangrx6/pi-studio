import { Accordion } from '../../shared/Accordion';
import { ChevronRight, Pencil, Plug, Plus, Trash2 } from 'lucide-react';
import { StatusGlyph } from '../../shared/StatusGlyph';
import { groupMcpServersByOwnership, type McpOwnershipFields } from './mcp-ownership';
import { mcpConnectionStatus } from './mcp-status';
import './styles/mcp-settings.css';

export type McpSettingsServer = McpOwnershipFields & {
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

function McpServerRow<T extends McpSettingsServer>({
  server,
  busy,
  recoveryPending,
  onOpen,
  onEdit,
  onToggle,
  onDelete,
}: {
  server: T;
  busy: boolean;
  recoveryPending: boolean;
  onOpen: (server: T) => void;
  onEdit: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => void;
  onDelete: (name: string) => void;
}) {
  const status = mcpConnectionStatus(server);
  const pluginOwned = server.origin === 'plugin' && Boolean(server.ownerPluginId?.trim());
  const protocolLabel = server.transport === 'stdio' ? 'STDIO' : 'HTTP';
  return <li className="mcp-server-row" data-state={status.state} data-origin={server.origin || 'user'}>
    <div className="mcp-server-copy">
      <div className="mcp-server-headline">
        <button type="button" className="mcp-server-open settings-row-link" aria-label={`查看 MCP ${server.name} 详情`} onClick={() => onOpen(server)}>
          <strong>{server.name}</strong><ChevronRight className="settings-row-link-indicator" aria-hidden="true" />
        </button>
        <span className="mcp-protocol-pill" title={server.transport === 'stdio' ? '本地进程' : 'HTTP 服务'}>{protocolLabel}</span>
        {pluginOwned && <span className="mcp-server-origin">{server.managed ? '插件托管' : '插件附带'}{server.userOverride ? ' · 已改配置' : ''}</span>}
      </div>
      {server.description && <p className="mcp-server-description">{server.description}</p>}
      <code className="mcp-server-target" title={server.target}>{server.target}</code>
      <div className="mcp-server-meta">
        <span className="mcp-server-state"><StatusGlyph state={status.state === 'connected' ? 'on' : status.state === 'error' ? 'attention' : 'off'} />{status.label}</span>
        <span className="mcp-meta-sep" aria-hidden="true">·</span>
        <span>{server.transport === 'stdio' ? '本地进程' : 'HTTP 服务'}</span>
        <span className="mcp-meta-sep" aria-hidden="true">·</span>
        <span>{server.exposure === 'deferred' ? '按需搜索' : server.exposure === 'direct' ? '直接提供' : '隐藏工具'}</span>
      </div>
      {server.error.trim() && <Accordion className="mcp-server-error" summary={<>{server.enabled ? '查看错误' : '查看上次连接错误'}</>}>
        <pre tabIndex={0}>{server.error}</pre>
      </Accordion>}
    </div>
    <div className="mcp-server-actions">
      <button type="button" className={`switch ${server.enabled ? 'is-on' : ''}`} role="switch" aria-checked={server.enabled}
        disabled={busy || recoveryPending} onClick={() => onToggle(server.name, !server.enabled)} aria-label={`${server.name} ${server.enabled ? '禁用' : '启用'}`}><span /></button>
      <button type="button" className="icon-button" disabled={busy} aria-label={`编辑 ${server.name}`} title="编辑" onClick={() => onEdit(server.name)}><Pencil /></button>
      <button type="button" className="icon-button" data-destructive="true" disabled={busy || recoveryPending} aria-label={`删除 MCP ${server.name}`} title="删除" onClick={() => onDelete(server.name)}><Trash2 /></button>
    </div>
  </li>;
}

export function McpSettings<T extends McpSettingsServer>({ servers, busy, recoveryPending = false, refreshBusy = false, onAdd, onOpen, onEdit, onToggle, onDelete, onBrowsePlugins }: {
  servers: readonly T[];
  busy: boolean;
  recoveryPending?: boolean;
  refreshBusy?: boolean;
  onAdd: () => void;
  onOpen: (server: T) => void;
  onEdit: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => void;
  onDelete: (name: string) => void;
  onBrowsePlugins?: () => void;
}) {
  const groups = groupMcpServersByOwnership(servers);
  const showGroupHeaders = groups.some((group) => group.ownerPluginId);
  return <div className="settings-sections mcp-settings">
    {servers.length ? <div className="mcp-server-groups" aria-label="MCP 服务器">
      {groups.map((group) => {
        if (!group.servers.length && group.ownerPluginId) return null;
        if (!group.servers.length && showGroupHeaders) {
          return <section className="mcp-server-group" key="user-empty" aria-label={group.label}>
            <header className="mcp-server-group-header">
              <h3>{group.label}</h3>
              <span>暂无</span>
            </header>
          </section>;
        }
        if (!group.servers.length) return null;
        return <section className="mcp-server-group" key={group.ownerPluginId || 'user'} aria-label={group.label}>
          {showGroupHeaders && <header className="mcp-server-group-header">
            <h3>{group.label}</h3>
            <span>{group.servers.length} 个</span>
          </header>}
          <ul className="mcp-server-list">
            {group.servers.map((server) => (
              <McpServerRow
                key={server.name}
                server={server}
                busy={busy}
                recoveryPending={recoveryPending}
                onOpen={onOpen}
                onEdit={onEdit}
                onToggle={onToggle}
                onDelete={onDelete}
              />
            ))}
          </ul>
        </section>;
      })}
    </div> : <div className="plugin-hub-empty">
      <span className="plugin-hub-empty-mark" aria-hidden="true"><Plug /></span>
      <h3>还没有 MCP 服务器</h3>
      <p>连接本地进程或远程 HTTP 服务后，可在对话中按需发现并调用外部工具。</p>
      <div className="plugin-hub-empty-actions">
        <button type="button" className="settings-save" disabled={busy || refreshBusy} aria-label="添加 MCP 服务器" onClick={onAdd}><Plus aria-hidden="true" />添加服务器</button>
        {onBrowsePlugins && <button type="button" className="settings-outline" onClick={onBrowsePlugins}>浏览插件</button>}
      </div>
    </div>}
  </div>;
}
