import { FolderOpen, RotateCw, Settings2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ActionMenu } from '../../shared/ActionMenu';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { useSettingsToast } from '../../shared/SettingsToast';
import { errorText } from '../../shared/error-text';
import type { ModalDismiss } from '../../shared/useModalDialog';
import type { PluginInstallPreview, PluginMarketItem, PluginMarketSnapshot, SettingsSnapshot, StudioPluginSummary } from '../../types/global';
import { PluginDetail, PluginInstallReview, type OpenPluginResource } from './PluginDetails';
import { PluginCatalog } from './PluginCatalog';
import { PluginSources } from './PluginSources';
import { PluginWorkspaceAction } from './PluginWorkspaceHeader';
import './styles/plugin-workspace.css';
import './styles/plugin-settings.css';

type Operation = 'prepare' | 'install' | 'toggle' | 'uninstall';

let cachedPluginMarket: PluginMarketSnapshot | undefined;

export function PluginSettings({
  plugins,
  busy,
  cwd,
  toolbar,
  showStatusFilter = false,
  openablePanels,
  onOpenApp,
  onChanged,
  onOpenResource,
}: {
  plugins: readonly StudioPluginSummary[];
  busy: boolean;
  cwd: string;
  toolbar: HTMLDivElement | null;
  showStatusFilter?: boolean;
  openablePanels?: ReadonlyMap<string, string>;
  onOpenApp?: (panelId: string) => void;
  onChanged: (settings: SettingsSnapshot, message: string) => void;
  onOpenResource?: OpenPluginResource;
}) {
  const showToast = useSettingsToast();
  const confirmation = useActionConfirmation();
  const [operation, setOperation] = useState<Operation>();
  const [preparingId, setPreparingId] = useState('');
  const lock = useRef<Operation | undefined>(undefined);
  const active = useRef(false);
  const reviewToken = useRef('');
  const reviewOrigin = useRef<HTMLButtonElement>();
  const reviewSource = useRef<string>();
  const [localMenu, setLocalMenu] = useState<HTMLButtonElement>();
  const [detail, setDetail] = useState<{ id: string; sourceId?: string }>();
  const [review, setReview] = useState<PluginInstallPreview>();
  const [installError, setInstallError] = useState('');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [catalog, setCatalog] = useState<PluginMarketSnapshot | undefined>(() => cachedPluginMarket);
  const [catalogLoading, setCatalogLoading] = useState(!cachedPluginMarket);
  const [catalogError, setCatalogError] = useState('');
  const [catalogRevision, setCatalogRevision] = useState(0);
  const locked = busy || operation !== undefined;
  const catalogUnavailable = (!catalog && catalogLoading) || Boolean(catalogError);
  const installed = detail && plugins.find(plugin => plugin.id === detail.id);
  const detailListings = detail?.sourceId ? catalog?.catalogs.find(source => source.source.id === detail.sourceId)?.plugins : catalog?.plugins;
  const detailItem = detail && (detailListings?.find(item => item.id === detail.id) ?? installed);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (lock.current !== 'install') disposeReview();
    };
  }, []);

  useEffect(() => {
    let current = true;
    setCatalogLoading(true);
    setCatalogError('');
    void window.piApi.pluginMarket().then(
      value => {
        cachedPluginMarket = value;
        if (current) setCatalog(value);
      },
      error => { if (current) setCatalogError(errorText(error)); },
    ).finally(() => { if (current) setCatalogLoading(false); });
    return () => { current = false; };
  }, [catalogRevision]);

  const refreshCatalog = () => setCatalogRevision(value => value + 1);

  function disposeReview() {
    const token = reviewToken.current;
    reviewToken.current = '';
    if (token) void window.piApi.disposePluginInstall(token).catch(() => {});
  }

  function focusOrigin(origin: HTMLButtonElement) {
    requestAnimationFrame(() => {
      if (active.current && origin.isConnected) origin.focus({ preventScroll: true });
    });
  }

  function closeReview() {
    const origin = reviewOrigin.current;
    reviewOrigin.current = undefined;
    disposeReview();
    setReview(undefined);
    if (origin) focusOrigin(origin);
  }

  function begin(next: Operation) {
    if (busy || lock.current) return false;
    lock.current = next;
    setOperation(next);
    return true;
  }

  function finish() {
    lock.current = undefined;
    if (active.current) {
      setOperation(undefined);
      setPreparingId('');
    }
  }

  async function prepare(origin: HTMLButtonElement, load: () => Promise<PluginInstallPreview | undefined>, sourceId?: string, targetId = '') {
    if (!begin('prepare')) return;
    setPreparingId(targetId);
    try {
      const preview = await load();
      if (!preview) return;
      reviewToken.current = preview.token;
      if (!active.current) {
        disposeReview();
        return;
      }
      reviewOrigin.current = origin;
      reviewSource.current = sourceId;
      setInstallError('');
      setReview(preview);
    } catch (error) {
      if (active.current) showToast(errorText(error), 'error');
    } finally {
      finish();
      if (!reviewOrigin.current) focusOrigin(origin);
    }
  }

  function prepareLocal(kind: 'directory' | 'package', origin: HTMLButtonElement) {
    void prepare(origin, async () => {
      const source = await window.piApi.pickPluginSource(kind);
      if (source && active.current) return window.piApi.preparePluginInstall({ source });
    });
  }

  function prepareMarket(item: PluginMarketItem, origin: HTMLButtonElement) {
    void prepare(origin, () => window.piApi.prepareMarketPlugin({
      id: item.id,
      sourceId: item.sourceId,
      version: item.latestVersion || undefined,
    }), item.sourceId, item.id);
  }

  async function install(dismiss: ModalDismiss) {
    if (!review?.canInstall || !begin('install')) return;
    setInstallError('');
    try {
      const result = await window.piApi.installPlugin({ token: review.token, cwd });
      reviewToken.current = '';
      reviewOrigin.current = undefined;
      onChanged(result.settings, review.existingVersion ? '插件已更新' : '插件已安装');
      await dismiss(() => {
        setReview(undefined);
        setDetail({ id: result.plugin.id, sourceId: reviewSource.current });
      });
    } catch (error) {
      if (active.current) setInstallError(errorText(error));
      else disposeReview();
    } finally {
      finish();
    }
  }

  async function toggle(plugin: StudioPluginSummary) {
    if (!begin('toggle')) return;
    const enabled = !plugin.enabled;
    try {
      const { settings } = await window.piApi.setPluginEnabled({ id: plugin.id, enabled, cwd });
      onChanged(settings, enabled ? '插件已启用' : '插件已停用');
    } catch (error) {
      showToast(errorText(error), 'error');
    } finally {
      finish();
    }
  }

  async function uninstall(plugin: StudioPluginSummary) {
    if (locked) return;
    const accepted = await confirmation.confirm({
      title: `卸载插件「${plugin.name}」？`,
      description: '将移除该插件及其托管资源，保留已自定义的资源配置。',
      confirmLabel: '卸载插件',
      tone: 'danger',
    });
    if (!accepted || !active.current || !begin('uninstall')) return;
    try {
      const { settings } = await window.piApi.uninstallPlugin({ id: plugin.id, cwd });
      onChanged(settings, '插件已卸载');
      if (active.current) setDetail(undefined);
    } catch (error) {
      showToast(errorText(error), 'error');
    } finally {
      finish();
    }
  }

  return <div className="plugin-settings-page">
    {toolbar && createPortal(<>
      <button type="button" className="icon-button" aria-label="刷新目录" title="刷新目录" disabled={catalogLoading || locked}
        onClick={refreshCatalog}><RotateCw className={catalogLoading ? 'spin' : undefined} aria-hidden="true" /></button>
      <PluginWorkspaceAction label="管理插件源" icon={<Settings2 aria-hidden="true" />} disabled={locked} onClick={() => setSourcesOpen(true)} />
      <PluginWorkspaceAction label="本地安装" icon={<FolderOpen aria-hidden="true" />} primary disabled={locked}
        aria-haspopup="menu" aria-expanded={Boolean(localMenu)} onClick={event => setLocalMenu(localMenu ? undefined : event.currentTarget)} />
    </>, toolbar)}
    <PluginCatalog
      plugins={plugins}
      catalog={catalog}
      loading={catalogLoading}
      error={catalogError}
      busy={locked}
      catalogUnavailable={catalogUnavailable}
      preparingId={operation === 'prepare' ? preparingId : ''}
      showStatusFilter={showStatusFilter}
      openablePanels={openablePanels}
      onOpenApp={onOpenApp}
      onToggle={toggle}
      onInstall={prepareMarket}
      onOpen={({ item }) => setDetail({ id: item.id, sourceId: 'sourceId' in item ? item.sourceId : undefined })}
    />
    {localMenu && <ActionMenu anchor={localMenu} placement="below" align="end" onClose={() => setLocalMenu(undefined)} items={[
      { label: '选择插件目录…', run: () => prepareLocal('directory', localMenu) },
      { label: '选择插件包…', run: () => prepareLocal('package', localMenu) },
    ]} />}
    {detailItem && <PluginDetail
      key={detailItem.id}
      item={detailItem}
      installed={installed}
      busy={locked}
      preparing={operation === 'prepare' && preparingId === detailItem.id}
      catalogUnavailable={catalogUnavailable}
      openablePanelId={openablePanels?.get(detailItem.id)}
      onOpenApp={onOpenApp}
      onClose={() => setDetail(undefined)}
      onOpenResource={onOpenResource}
      onInstall={prepareMarket}
      onUninstall={uninstall}
    />}
    {review && <PluginInstallReview preview={review} busy={operation === 'install'} error={installError}
      onClose={closeReview} onSubmit={dismiss => void install(dismiss)} />}
    {sourcesOpen && <PluginSources onClose={() => setSourcesOpen(false)} onChanged={refreshCatalog} />}
    {confirmation.dialog}
  </div>;
}
