import { useEffect, useState } from 'react';
import { Copy, HardDrive, RotateCw } from 'lucide-react';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { PreferenceGroup, PreferenceRow } from '../../shared/PreferenceGroup';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { LoadingState } from '../../shared/LoadingState';
import { useDeferredEnter } from '../../shared/useDeferredEnter';
import { useSettingsToast } from '../../shared/SettingsToast';
import { errorText } from '../../shared/error-text';
import { formatFileSize } from '../../shared/filesize';
import { revealFileLabel } from '../../shared/desktop-platform';
import type { DeviceStorageSnapshot, StorageCategory, StorageLocation } from '../../types/device-storage';
import './styles/device-storage.css';

const categories: { id: StorageCategory; label: string }[] = [
  { id: 'database', label: '会话与数据库' }, { id: 'attachments', label: '会话附件' },
  { id: 'worktrees', label: '隔离工作树' }, { id: 'resources', label: '配置与扩展' },
  { id: 'media', label: '壁纸与下载' }, { id: 'client', label: '客户端数据' }, { id: 'other', label: '其他数据' },
];
const locationNames: Record<StorageLocation['kind'], string> = {
  studio: '应用数据', client: '客户端数据', session: '浏览器会话数据', database: '独立数据库',
  worktrees: '外置隔离工作树', project: '项目配置', updates: '更新缓存',
};
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });

function UsageBreakdown({ snapshot }: { snapshot: DeviceStorageSnapshot }) {
  const partial = snapshot.locations.some(row => row.status !== 'ready');
  const available = snapshot.locations.some(row => row.status !== 'unavailable');
  return <div className="storage-breakdown">
    <div className="storage-reading">
      <strong aria-live="polite">{available ? formatFileSize(snapshot.totalBytes) : '暂不可用'}</strong>
      <span>{(partial || snapshot.locationsIncomplete) && available ? '已统计部分位置 · ' : ''}更新于 <time dateTime={new Date(snapshot.measuredAt).toISOString()}>{timeFormat.format(snapshot.measuredAt)}</time></span>
    </div>
    {available && <>
      <div className="storage-meter" aria-hidden="true">
        {categories.filter(({ id }) => snapshot.categories[id] > 0).map(({ id }) =>
          <span key={id} data-category={id} style={{ flexGrow: snapshot.categories[id] / snapshot.totalBytes }} />)}
      </div>
      <dl className="storage-legend" aria-label="各类数据占用">
        {categories.map(({ id, label }) => <div key={id} data-category={id}>
          <dt><i aria-hidden="true" />{label}</dt><dd>{formatFileSize(snapshot.categories[id])}</dd>
        </div>)}
      </dl>
    </>}
    {partial && <p className="storage-partial" role="status">部分文件或位置无法读取。可在下方查看，连接磁盘后刷新。</p>}
    {snapshot.locationsIncomplete && <p className="storage-partial" role="status">部分存储位置未能识别，可刷新重试。</p>}
  </div>;
}

function LocationRow({ location }: { location: StorageLocation }) {
  const toast = useSettingsToast();
  const [busy, setBusy] = useState(false);
  const title = location.shared ? '应用与客户端数据' : locationNames[location.kind];
  const label = title + ' · ' + location.place + ' › ' + location.name;
  async function useLocation(action: 'open' | 'copy') {
    if (busy) return;
    setBusy(true);
    try {
      await window.piApi.deviceStorageLocation(location.id, action);
      if (action === 'copy') toast('已复制完整路径。');
    } catch (error) { toast(errorText(error), 'error'); }
    finally { setBusy(false); }
  }
  return <PreferenceRow title={title} description={<>{location.place}<span aria-hidden="true"> › </span>{location.name}</>}
    control={<>
      <span className="storage-location-size">{location.status === 'unavailable' ? '位置不可用'
        : (location.status === 'partial' ? '已统计 ' : '') + formatFileSize(location.bytes)}</span>
      <button type="button" className="icon-button" aria-label={'复制完整路径 · ' + label} title="复制完整路径"
        disabled={!location.canOpen || busy} onClick={() => void useLocation('copy')}><Copy aria-hidden="true" /></button>
      <button type="button" className="settings-outline" title={revealFileLabel()} aria-label={revealFileLabel() + ' · ' + label}
        disabled={!location.canOpen || busy} onClick={() => void useLocation('open')}>{location.kind === 'database' ? '定位文件' : '打开文件夹'}</button>
    </>} />;
}

let cachedStorageSnapshot: DeviceStorageSnapshot | undefined;

export function DeviceStorageSettings({ onOpenArchives, onOpenWorktrees }: { onOpenArchives: () => void; onOpenWorktrees: () => void }) {
  const toast = useSettingsToast();
  const confirmation = useActionConfirmation();
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<DeviceStorageSnapshot | undefined>(cachedStorageSnapshot);
  const [busy, setBusy] = useState(!cachedStorageSnapshot);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (snapshot) cachedStorageSnapshot = snapshot;
  }, [snapshot]);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError('');
    window.piApi.deviceStorage().then(
      next => { if (active) { cachedStorageSnapshot = next; setSnapshot(next); } },
      cause => { if (active) setError(errorText(cause)); },
    ).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [revision]);

  const maintenance = snapshot?.maintenance;
  const cleanable = maintenance?.totalCleanableBytes || 0;
  const maintenanceParts = [
    maintenance?.oldBackupCount ? `旧备份 ${maintenance.oldBackupCount} 份（${formatFileSize(maintenance.oldBackupBytes)}）` : '',
    maintenance?.reclaimableDatabaseBytes ? `数据库空闲页 ${formatFileSize(maintenance.reclaimableDatabaseBytes)}` : '',
    maintenance?.cacheBytes ? `临时缓存 ${formatFileSize(maintenance.cacheBytes)}` : '',
  ].filter(Boolean);
  const cleanupDescription = cleanable > 0
    ? `当前可释放 ${formatFileSize(cleanable)}（${maintenanceParts.join('、')}）`
    : '空间紧凑，可手动清理缓存并压缩数据库';

  async function runCleanup() {
    if (cleaning || busy) return;
    const details = [
      maintenance?.oldBackupCount ? `旧迁移备份 ${maintenance.oldBackupCount} 份（${formatFileSize(maintenance.oldBackupBytes)}）` : '',
      maintenance?.reclaimableDatabaseBytes ? `数据库空闲页（${formatFileSize(maintenance.reclaimableDatabaseBytes)}）` : '',
      maintenance?.cacheBytes ? `模型目录与临时缓存（${formatFileSize(maintenance.cacheBytes)}）` : '',
    ].filter(Boolean);
    const accepted = await confirmation.confirm({
      title: '清理并优化存储空间？',
      description: `${details.length ? `将处理：${details.join('、')}，并保留最新一份数据库迁移快照。` : '将清理过期备份、临时缓存和空目录，并压缩数据库空间。'}不会删除任何会话记录、设置、插件、技能或扩展。`,
      confirmLabel: '开始整理',
    });
    if (!accepted) return;
    setCleaning(true);
    try {
      const result = await window.piApi.deviceStorageCleanup();
      setSnapshot(result.snapshot);
      const freed = result.summary.freedBytes;
      toast(freed > 0
        ? `存储整理完成，已释放 ${formatFileSize(freed)}。`
        : result.summary.removedEmptyDirs > 0
          ? `存储整理完成，已清理 ${result.summary.removedEmptyDirs} 个空目录。`
          : '存储空间已处于紧凑状态。');
    } catch (cause) {
      toast(errorText(cause), 'error');
    } finally {
      setCleaning(false);
    }
  }

  const revealData = useDeferredEnter(Boolean(snapshot));

  return <div className="settings-preference-page device-storage-settings">
    <SettingsPageHeader title="设备存储" icon={<HardDrive />} iconPosition="end" meta="查看 Pi Studio 在这台设备上的数据占用和存储位置。" />
    <div className="settings-preference-groups">
      <PreferenceGroup title="已用空间" actions={<button type="button" className="settings-outline" disabled={busy || cleaning}
        onClick={() => setRevision(value => value + 1)}><RotateCw className={busy ? 'spin' : ''} aria-hidden="true" />{busy ? '统计中' : '刷新'}</button>}>
        {!snapshot && busy && <LoadingState variant="section">正在统计文件大小…</LoadingState>}
        {error && <p className="storage-error" role="alert">{error}{snapshot ? ' 当前显示上次统计结果。' : ''}</p>}
        {snapshot && <div className={revealData ? 'settings-async-ready' : undefined}><UsageBreakdown snapshot={snapshot} /></div>}
      </PreferenceGroup>
      {snapshot && <PreferenceGroup title="存储位置" description="工作区内仅统计 .pi-studio 目录">
        <div className={`storage-locations${revealData ? ' settings-async-ready' : ''}`}>{snapshot.locations.map(location => <LocationRow key={location.id} location={location} />)}</div>
      </PreferenceGroup>}
      <PreferenceGroup title="数据管理">
        <PreferenceRow title="归档会话" description="查看或恢复已归档对话"
          control={<button type="button" className="settings-outline storage-management-action" onClick={onOpenArchives}>查看归档会话</button>} />
        <PreferenceRow title="隔离工作树" description="管理子智能体工作副本"
          control={<button type="button" className="settings-outline storage-management-action" onClick={onOpenWorktrees}>管理工作树</button>} />
        <PreferenceRow title="空间整理" description={cleanupDescription}
          control={<button type="button" className="settings-outline storage-management-action" disabled={busy || cleaning}
            onClick={() => void runCleanup()}>{cleaning ? '整理中…' : '清理与优化'}</button>} />
      </PreferenceGroup>
    </div>
    {confirmation.dialog}
  </div>;
}
