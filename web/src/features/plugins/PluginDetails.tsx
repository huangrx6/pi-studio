import { ChevronRight, Download, ExternalLink, Trash2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { DetailDialog } from '../../shared/DetailDialog';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { useSettingsToast } from '../../shared/SettingsToast';
import { errorText } from '../../shared/error-text';
import { PackageIcon } from '../../shared/PackageIcon';
import type { ModalDismiss } from '../../shared/useModalDialog';
import type { PluginInstallPreview, PluginMarketItem, StudioPluginSummary } from '../../types/global';
import type { PluginCatalogEntry } from './plugin-catalog';

type PluginProvides = StudioPluginSummary['provides'] | PluginMarketItem['provides'];
type ResourceSection = 'mcp' | 'skills' | 'extensions';
export type OpenPluginResource = (section: ResourceSection) => void;

function count(value: number | unknown[] | undefined) {
  return typeof value === 'number' ? value : value?.length ?? 0;
}

export type PluginResourceBadge = {
  kind: 'mcp' | 'skills' | 'cli' | 'extension';
  label: string;
};

export function pluginResourceBadges(provides: PluginProvides): PluginResourceBadge[] {
  const mcp = count(provides.mcp);
  const skills = count(provides.skills);
  const cli = count(provides.cli);
  const items: PluginResourceBadge[] = [];
  if (mcp) items.push({ kind: 'mcp', label: `${mcp} 个 MCP` });
  if (skills) items.push({ kind: 'skills', label: `${skills} 个技能` });
  if (cli) items.push({ kind: 'cli', label: `${cli} 个命令行工具` });
  if (provides.extension) items.push({ kind: 'extension', label: '界面扩展' });
  return items;
}

export function pluginResourceLabels(provides: PluginProvides) {
  return pluginResourceBadges(provides).map(item => item.label);
}

function PackageResources({ provides, onOpen }: { provides: PluginProvides; onOpen?: OpenPluginResource }) {
  const blocks: {
    title: string;
    total: number;
    entries?: ReactNode;
    section?: ResourceSection;
  }[] = [
    {
      title: 'MCP 服务器',
      total: count(provides.mcp),
      section: 'mcp',
      entries: Array.isArray(provides.mcp)
        ? provides.mcp.map(item => <li key={item.name}><code>{item.name}</code>{item.description && <small>{item.description}</small>}</li>)
        : 'mcpNames' in provides && provides.mcpNames?.map(name => <li key={name}><code>{name}</code></li>),
    },
    {
      title: '技能',
      total: count(provides.skills),
      section: 'skills',
      entries: Array.isArray(provides.skills)
        ? provides.skills.map(item => <li key={item.path}>{item.name || item.path}</li>)
        : 'skillNames' in provides && provides.skillNames?.map(name => <li key={name}>{name}</li>),
    },
    {
      title: '命令行工具',
      total: count(provides.cli),
      entries: Array.isArray(provides.cli)
        ? provides.cli.map(item => <li key={item.id}>
          <span>{item.name}</span>
          {item.description && <small>{item.description}</small>}
          {item.commands?.map((command, index) => <code key={index}>{command.example || command.summary}</code>)}
        </li>)
        : 'cliNames' in provides && provides.cliNames?.map(name => <li key={name}><code>{name}</code></li>),
    },
    {
      title: '界面扩展',
      total: provides.extension ? 1 : 0,
      section: 'extensions',
      entries: typeof provides.extension === 'object' && provides.extension
        ? provides.extension.tools?.length
          ? provides.extension.tools.map(name => <li key={name}><code>{name}</code></li>)
          : <li><code>{provides.extension.path}</code></li>
        : null,
    },
  ];
  return <div className="plugin-resource-list">
    {blocks.filter(block => block.total).map(({ title, total, entries, section }) => <section className="plugin-resource-block" key={title}>
      <div>
        <h4>{title}</h4>
        <small>{total} 项</small>
        {section && onOpen && <button type="button" className="settings-text-button" onClick={() => onOpen(section)}>
          查看{title}<ChevronRight aria-hidden="true" />
        </button>}
      </div>
      {entries && (!Array.isArray(entries) || entries.length > 0) && <ul>{entries}</ul>}
    </section>)}
  </div>;
}

export function PluginDetail({ item, installed, busy, catalogUnavailable, onClose, onOpenResource, onInstall, onUninstall }: PluginCatalogEntry & {
  busy: boolean;
  catalogUnavailable: boolean;
  onClose: () => void;
  onOpenResource: OpenPluginResource;
  onInstall: (listing: PluginMarketItem, origin: HTMLButtonElement) => void;
  onUninstall: (plugin: StudioPluginSummary) => void;
}) {
  const showToast = useSettingsToast();
  const listing = 'sourceId' in item ? item : undefined;
  const version = installed?.version || listing?.latestVersion;
  const description = item.description || listing?.summary || installed?.description;
  const provides = installed?.provides ?? item.provides;
  return <DetailDialog className="plugin-package-dialog" label={`插件 ${item.name}`}
    dismissable={!busy} onClose={onClose}>{close => <>
    <header className="detail-header">
      <div className="detail-heading">
        <span className="detail-icon"><PackageIcon source={item.iconDataUrl || installed?.iconDataUrl} name={item.name} /></span>
        <div><h2>{item.name}</h2><p>{[item.publisher, version && `v${version}`].filter(Boolean).join(' · ')}</p></div>
      </div>
      <button type="button" className="icon-button" aria-label="关闭" disabled={busy} onClick={close}><X aria-hidden="true" /></button>
    </header>
    <div className="detail-body plugin-package-body">
      {description && <p>{description}</p>}
      <dl className="detail-list">
        <div><dt>插件 ID</dt><dd><code>{item.id}</code></dd></div>
        {listing && <div><dt>目录来源</dt><dd>{listing.sourceName}</dd></div>}
        {installed && <div><dt>已装版本</dt><dd>v{installed.version} · {installed.enabled ? '已启用' : '已停用'}</dd></div>}
        {listing && installed && listing.latestVersion !== installed.version && <div><dt>来源版本</dt><dd>v{listing.latestVersion}</dd></div>}
      </dl>
      {pluginResourceLabels(provides).length > 0 && <section>
        <h3>{installed ? '已安装的资源' : '附带资源'}</h3>
        <PackageResources provides={provides} onOpen={installed ? onOpenResource : undefined} />
      </section>}
    </div>
    <footer className="detail-footer plugin-package-footer">
      {installed && <button type="button" className="settings-outline plugin-remove-button" disabled={busy} onClick={() => onUninstall(installed)}>
        <Trash2 aria-hidden="true" />卸载插件
      </button>}
      {item.homepage && <button type="button" className="settings-outline" disabled={busy}
        onClick={() => void window.piApi.openExternal(item.homepage).catch(error => showToast(errorText(error), 'error'))}>
        <ExternalLink aria-hidden="true" />项目主页
      </button>}
      <span />
      {listing && <button type="button" className={installed ? 'settings-outline' : 'settings-save'} disabled={busy || catalogUnavailable}
        onClick={event => onInstall(listing, event.currentTarget)}>
        <Download aria-hidden="true" />{!installed ? '安装' : installed.version === listing.latestVersion ? '重新安装' : '更换版本'}
      </button>}
      {installed && <button type="button" className="settings-outline" disabled={busy} onClick={close}>完成</button>}
    </footer>
  </>}</DetailDialog>;
}

export function PluginInstallReview({ preview, busy, error, onClose, onSubmit }: {
  preview: PluginInstallPreview;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (dismiss: ModalDismiss) => void;
}) {
  const action = preview.upgrade ? '安装此版本' : preview.existingVersion ? '重新安装' : '确认安装';
  return <SettingsDialog wide className="plugin-form-dialog" title="安装预览" description="确认插件版本和附带资源后继续。"
    action={action} busyAction="正在安装…" busy={busy} loading={false} unavailable={!preview.canInstall}
    error={error || null} autoFocusFirstField={false} onClose={onClose} onSubmit={onSubmit}>
    <div className="plugin-flat-form plugin-install-review">
      <section className="plugin-flat-section">
        <div className="plugin-review-hero">
          <span className="plugin-package-icon"><PackageIcon source={preview.iconDataUrl} name={preview.name} /></span>
          <div className="plugin-review-hero-copy">
            <h3>{preview.name}</h3>
            {preview.description && <p>{preview.description}</p>}
          </div>
        </div>
        <dl className="detail-list plugin-review-facts">
          <div><dt>插件 ID</dt><dd><code>{preview.id}</code></dd></div>
          {preview.publisher && <div><dt>发布者</dt><dd>{preview.publisher}</dd></div>}
          {preview.existingVersion && <div><dt>已装版本</dt><dd>v{preview.existingVersion}</dd></div>}
          <div><dt>安装版本</dt><dd>v{preview.version}</dd></div>
        </dl>
      </section>
      {pluginResourceLabels(preview.provides).length > 0 && <section className="plugin-flat-section">
        <h3>附带资源</h3>
        <PackageResources provides={preview.provides} />
      </section>}
      {preview.collisions.length > 0 && <section className="plugin-flat-section plugin-install-conflicts" role="alert">
        <h3>名称冲突</h3>
        <p>请先处理下列同名资源，再重新准备安装。</p>
        <ul>{preview.collisions.map(item => <li key={`${item.kind}:${item.name}`}>
          {item.kind === 'mcp' ? 'MCP 服务器' : '扩展'} · <code>{item.name}</code>
        </li>)}</ul>
      </section>}
    </div>
  </SettingsDialog>;
}
