import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, Monitor, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { PreferenceGroup, PreferenceRow } from '../../shared/PreferenceGroup';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { useSettingsToast } from '../../shared/SettingsToast';
import { LoadingState } from '../../shared/LoadingState';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { errorText } from '../../shared/error-text';
import { isComposingKey } from '../../shared/keyboard-navigation';
import './styles/desktop-control-settings.css';

type DesktopAllowApp = {
  id: string;
  name: string;
  bundleId?: string;
  path?: string;
  icon?: string;
  blocked?: boolean;
  running?: boolean;
};

type DesktopActivityEntry = {
  id: string;
  at: number;
  tool: string;
  ok: boolean;
  code?: string;
  appName?: string;
  bundleId?: string;
  windowId?: number | null;
  title?: string;
  detail?: string;
};

type DesktopPermissionStatus = {
  platform: string;
  supported: boolean;
  screenRecording: string;
  accessibility: boolean;
  ready: boolean;
  message?: string;
};

type DesktopControlPreferences = {
  enabled: boolean;
  allowAnyApp: boolean;
  alwaysAllow: DesktopAllowApp[];
};

type DesktopControlStatus = {
  enabled: boolean;
  allowAnyApp: boolean;
  alwaysAllowCount: number;
  alwaysAllow: DesktopAllowApp[];
  permission: DesktopPermissionStatus;
  platform: string;
  supported: boolean;
  ready: boolean;
  activity?: DesktopActivityEntry[];
};

const emptyStatus = (): DesktopControlStatus => ({
  enabled: false,
  allowAnyApp: false,
  alwaysAllowCount: 0,
  alwaysAllow: [],
  permission: {
    platform: 'darwin',
    supported: true,
    screenRecording: 'unknown',
    accessibility: false,
    ready: false,
    message: '',
  },
  platform: 'darwin',
  supported: true,
  ready: false,
  activity: [],
});


function initialLetter(name: string) {
  const text = String(name || '').trim();
  return text ? text.slice(0, 1).toUpperCase() : '?';
}

function formatActivityTime(at: number) {
  try {
    return new Date(at).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(at || '');
  }
}

function activityLabel(tool: string) {
  switch (String(tool || '')) {
    case 'desktop_apps': return '列出应用';
    case 'desktop_windows': return '列出窗口';
    case 'desktop_snapshot': return '读取结构';
    case 'desktop_screenshot': return '窗口截图';
    case 'desktop_click': return '点击';
    case 'desktop_type': return '输入';
    case 'desktop_scroll': return '滚动';
    case 'desktop_drag': return '拖拽';
    case 'desktop_hotkey': return '快捷键';
    default: return tool || '观察';
  }
}

export function DesktopControlSettings() {
  const confirmation = useActionConfirmation();
  const [status, setStatus] = useState<DesktopControlStatus | null>(null);
  const [installed, setInstalled] = useState<DesktopAllowApp[]>([]);
  const [installedError, setInstalledError] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [loadError, setLoadError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const generation = useRef(0);
  const showToast = useSettingsToast();
  const addButton = useRef<HTMLButtonElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const pickerWasOpen = useRef(false);
  useEffect(() => {
    if (pickerOpen) searchField.current?.focus();
    else if (pickerWasOpen.current) addButton.current?.focus();
    pickerWasOpen.current = pickerOpen;
  }, [pickerOpen]);

  const load = useCallback(async () => {
    const id = ++generation.current;
    setBusy('load');
    setLoadError('');
    try {
      const next = await window.piApi.desktopControlStatus();
      if (id !== generation.current) return;
      setStatus({ ...emptyStatus(), ...next, permission: { ...emptyStatus().permission, ...(next?.permission || {}) } });
    } catch (cause) {
      if (id === generation.current) setLoadError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  function mergeStatus(
    current: DesktopControlStatus | null,
    result: {
      status?: DesktopControlStatus;
      preferences?: DesktopControlPreferences;
      activity?: DesktopActivityEntry[];
    },
  ): DesktopControlStatus {
    const base = current || emptyStatus();
    if (result.status) {
      return {
        ...emptyStatus(),
        ...result.status,
        alwaysAllow: Array.isArray(result.status.alwaysAllow) ? result.status.alwaysAllow : base.alwaysAllow,
        permission: { ...base.permission, ...(result.status.permission || {}) },
        activity: Array.isArray(result.status.activity)
          ? result.status.activity
          : (Array.isArray(result.activity) ? result.activity : (base.activity || [])),
      };
    }
    const preferences = result.preferences;
    return {
      ...base,
      enabled: preferences?.enabled ?? base.enabled,
      allowAnyApp: preferences?.allowAnyApp ?? base.allowAnyApp,
      alwaysAllow: Array.isArray(preferences?.alwaysAllow) ? preferences.alwaysAllow : base.alwaysAllow,
      alwaysAllowCount: Array.isArray(preferences?.alwaysAllow)
        ? preferences.alwaysAllow.length
        : base.alwaysAllowCount,
      activity: Array.isArray(result.activity) ? result.activity : (base.activity || []),
    };
  }

  async function patch(partial: Partial<Pick<DesktopControlStatus, 'enabled' | 'allowAnyApp'>>, confirmOptions?: { title: string; description?: string; confirmLabel?: string; tone?: 'default' | 'danger' }) {
    if (!status || busy) return;
    if (confirmOptions) {
      const accepted = await confirmation.confirm({
        title: confirmOptions.title,
        description: confirmOptions.description,
        confirmLabel: confirmOptions.confirmLabel || '继续',
        tone: confirmOptions.tone || 'default',
      });
      if (!accepted) return;
    }
    const id = ++generation.current;
    setBusy('save');
    try {
      const result = await window.piApi.desktopControlSetPreferences(partial);
      if (id !== generation.current) return;
      setStatus(mergeStatus(status, result));
      showToast('已保存');
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function refreshPermissions() {
    const id = ++generation.current;
    setBusy('permissions');
    try {
      const [permission, nextStatus] = await Promise.all([
        window.piApi.desktopControlPermissions(),
        window.piApi.desktopControlStatus(),
      ]);
      if (id !== generation.current) return;
      setStatus({
        ...emptyStatus(),
        ...nextStatus,
        permission: { ...emptyStatus().permission, ...permission, ...(nextStatus?.permission || {}) },
      });
      showToast('已刷新系统权限状态');
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function openPermission(kind: 'screen' | 'accessibility') {
    setBusy(`open-${kind}`);
    try {
      await window.piApi.desktopControlOpenPermissionSettings({ kind });
      showToast(kind === 'screen' ? '已打开屏幕录制设置' : '已打开辅助功能设置');
    } catch (cause) {
      showToast(errorText(cause), 'error');
    } finally {
      setBusy('');
    }
  }

  async function loadInstalled() {
    setBusy('apps');
    setInstalledError('');
    try {
      const result = await window.piApi.desktopControlInstalledApps();
      if (!result?.ok) {
        setInstalled([]);
        setInstalledError(result?.error || '无法读取本机应用列表');
        return;
      }
      setInstalled(Array.isArray(result.apps) ? result.apps as DesktopAllowApp[] : []);
      setPickerOpen(true);
    } catch (cause) {
      setInstalled([]);
      setInstalledError(errorText(cause));
    } finally {
      setBusy('');
    }
  }

  async function addApp(app: DesktopAllowApp) {
    if (!app || app.blocked || busy) return;
    const id = ++generation.current;
    setBusy('add');
    try {
      const result = await window.piApi.desktopControlAlwaysAllowAdd({
        id: app.id,
        name: app.name,
        bundleId: app.bundleId,
        path: app.path,
      });
      if (id !== generation.current) return;
      setStatus((current) => mergeStatus(current, result));
      showToast(`已允许 ${app.name}`);
      setPickerOpen(false);
      setQuery('');
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function removeApp(app: DesktopAllowApp) {
    if (!app?.id || busy) return;
    const accepted = await confirmation.confirm({
      title: `移除「${app.name}」？`,
      description: '移除后，智能体需要重新获得对该应用的操作许可。',
      confirmLabel: '移除应用',
      tone: 'danger',
    });
    if (!accepted) return;
    const id = ++generation.current;
    setBusy('remove');
    try {
      const result = await window.piApi.desktopControlAlwaysAllowRemove({ id: app.id });
      if (id !== generation.current) return;
      setStatus((current) => mergeStatus(current, result));
      showToast(`已移除 ${app.name}`);
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function clearActivity() {
    if (busy) return;
    const accepted = await confirmation.confirm({
      title: '清空操作记录？',
      description: '将清除电脑操控的近期活动记录，不影响白名单设置。',
      confirmLabel: '清空记录',
      tone: 'danger',
    });
    if (!accepted) return;
    const id = ++generation.current;
    setBusy('activity');
    try {
      const result = await window.piApi.desktopControlActivityClear();
      if (id !== generation.current) return;
      setStatus((current) => {
        const base = mergeStatus(current, result);
        return {
          ...base,
          activity: Array.isArray(result.activity) ? result.activity : [],
        };
      });
      showToast('已清空观察记录');
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function refreshActivity() {
    if (busy) return;
    const id = ++generation.current;
    setBusy('activity-refresh');
    try {
      const result = await window.piApi.desktopControlActivity({ limit: 30 });
      if (id !== generation.current) return;
      setStatus((current) => mergeStatus(current, {
        activity: Array.isArray(result?.activity) ? result.activity : [],
      }));
      showToast('已刷新观察记录');
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  const allowedIds = useMemo(() => new Set((status?.alwaysAllow || []).map((item) => item.id)), [status]);

  const filteredInstalled = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = installed
      .filter((app) => !app.blocked && !allowedIds.has(app.id))
      .filter((app) => {
        if (!q) return true;
        return [app.name, app.bundleId, app.path].some((value) => String(value || '').toLowerCase().includes(q));
      });
    rows.sort((a, b) => {
      if (Boolean(a.running) !== Boolean(b.running)) return a.running ? -1 : 1;
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans');
    });
    return rows.slice(0, 120);
  }, [installed, allowedIds, query]);

  const permission = status?.permission;
  const disabled = Boolean(busy) || !status?.supported;
  const activity = status?.activity || [];

  return (
    <div className="settings-preference-page desktop-control-settings">
      {confirmation.dialog}
      <SettingsPageHeader title="电脑操控" iconPosition="end" meta="管理智能体可操作的应用，以及观察窗口所需的系统权限。"
        icon={<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="26" height="18" rx="3" /><path d="M16 23v4m-6 0h12" />
          <path d="m11.5 11.5 2.5 7 1.4-3.2 3.1-1.3z" stroke="var(--accent)" />
        </svg>} />
      {!status && (loadError ? <div className="desktop-load-error"><p role="alert">{loadError}</p>
        <button type="button" className="settings-outline" onClick={() => void load()}>重新加载</button></div>
        : <LoadingState variant="section">正在加载电脑操控设置…</LoadingState>)}
      {status && permission && <div className="settings-preference-groups">
        <PreferenceGroup title="控制范围" description={!status.supported ? '电脑操控目前仅支持 macOS。' : undefined}>
          <PreferenceRow
            title="启用电脑操控"
            description="允许智能体观察和操作已授权的应用窗口。观察内容会进入当前会话并发送给当前模型。"
            control={(
              <Switch
                checked={status.enabled}
                disabled={disabled}
                label="启用电脑操控"
                onChange={(checked) => void patch(
                  { enabled: checked },
                  checked ? {
                    title: '开启电脑操控？',
                    description: '开启后，智能体可在你授权的应用范围内控制本机界面。',
                    confirmLabel: '开启',
                    tone: 'danger',
                  } : undefined,
                )}
              />
            )}
          />
          <PreferenceRow
            title="任意应用"
            description="关闭时仅限下方允许的应用。开启后，范围扩大到阻断列表以外的前台应用。"
            control={(
              <Switch
                checked={status.allowAnyApp}
                disabled={disabled}
                label="允许任意应用"
                onChange={(checked) => void patch(
                  { allowAnyApp: checked },
                  checked ? {
                    title: '允许任意应用？',
                    description: '开启后，智能体可观察并操作除自身、终端与系统授权外的前台应用窗口。仍建议优先使用始终允许列表。',
                    confirmLabel: '开启',
                    tone: 'danger',
                  } : undefined,
                )}
              />
            )}
          />
        </PreferenceGroup>
        <PreferenceGroup title="系统权限" description={status.supported
          ? permission.message || (permission.ready ? '观察与操作所需的权限已就绪。' : '完成系统授权后请刷新状态。如仍未更新，请重启 Pi Studio。')
          : undefined}
          actions={<button type="button" className="settings-outline" disabled={Boolean(busy)} onClick={() => void refreshPermissions()}>
            <RefreshCw className={busy === 'permissions' ? 'spin' : undefined} aria-hidden="true" />{busy === 'permissions' ? '刷新中…' : '刷新'}
          </button>}>
          <div className="desktop-permission-grid">
            <PermissionTile
              icon={<Monitor aria-hidden="true" />}
              title="屏幕录制"
              description="用于截取已授权应用的窗口。"
              checked={permission.screenRecording === 'granted'}
              disabled={disabled}
              supported={status.supported}
              onClick={() => void openPermission('screen')}
            />
            <PermissionTile
              icon={<ShieldCheck aria-hidden="true" />}
              title="辅助功能"
              description="用于读取界面和操作窗口。密码框禁止读取明文和输入，系统快捷键会被拦截。"
              checked={permission.accessibility}
              disabled={disabled}
              supported={status.supported}
              onClick={() => void openPermission('accessibility')}
            />
          </div>
        </PreferenceGroup>
        <PreferenceGroup title="始终允许的应用" description="使用指定应用范围时，智能体只能访问列表中的应用。"
          actions={<button ref={addButton} type="button" className="settings-outline" disabled={disabled}
            aria-expanded={pickerOpen} aria-controls={pickerOpen ? 'desktop-app-picker' : undefined}
            onClick={() => {
              if (pickerOpen) { setPickerOpen(false); setQuery(''); }
              else void loadInstalled();
            }}>
            {!pickerOpen && <Plus aria-hidden="true" />}{pickerOpen ? '收起选择器' : busy === 'apps' ? '读取中…' : '添加应用'}
          </button>}>
          {installedError && <p className="desktop-load-error" role="alert">{installedError}</p>}
          {!pickerOpen && (status.alwaysAllow.length === 0 ? (
            <div className="desktop-control-row">
              <p className="desktop-control-empty">还没有始终允许的应用。</p>
            </div>
          ) : (
            <div className="desktop-control-app-grid">
              {status.alwaysAllow.map((app) => (
                <div className="desktop-control-app-card" key={app.id}>
                  {app.icon ? (
                    <img className="desktop-control-app-icon" src={app.icon} alt="" />
                  ) : (
                    <span className="desktop-control-app-fallback" aria-hidden="true">{initialLetter(app.name)}</span>
                  )}
                  <div className="desktop-control-app-copy">
                    <strong title={app.name}>{app.name}</strong>
                    <span title={app.bundleId || app.path || app.id}>{app.bundleId || app.path || app.id}</span>
                  </div>
                  <button type="button" className="icon-button desktop-app-remove" disabled={Boolean(busy)} onClick={() => void removeApp(app)} aria-label={`移除 ${app.name}`}>
                    <Trash2 />
                  </button>
                </div>
              ))}
            </div>
          ))}

          {pickerOpen && (
            <div className="desktop-control-picker" id="desktop-app-picker" onKeyDown={event => {
              if (event.key !== 'Escape' || isComposingKey(event.nativeEvent)) return;
              event.preventDefault();
              event.stopPropagation();
              setPickerOpen(false);
              setQuery('');
            }}>
              <input ref={searchField} type="search"
                className="desktop-control-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索应用名称"
                aria-label="搜索应用"
              />
              <div className="desktop-control-picker-list">
                {filteredInstalled.length === 0 ? (
                  <div className="desktop-control-row">
                    <p className="desktop-control-empty">没有可添加的应用。</p>
                  </div>
                ) : filteredInstalled.map((app) => (
                  <button
                    key={app.id}
                    type="button"
                    className="desktop-control-app"
                    disabled={Boolean(busy)}
                    onClick={() => void addApp(app)}
                  >
                    {app.icon ? (
                      <img className="desktop-control-app-icon" src={app.icon} alt="" />
                    ) : (
                      <span className="desktop-control-app-fallback" aria-hidden="true">{initialLetter(app.name)}</span>
                    )}
                    <div className="desktop-control-app-copy">
                      <strong>{app.name}</strong>
                      <span>
                        {app.running ? '运行中 · ' : ''}
                        {app.path || app.bundleId || app.id}
                      </span>
                    </div>
                    <Plus />
                  </button>
                ))}
              </div>
            </div>
          )}
        </PreferenceGroup>
        <PreferenceGroup title="最近活动" summary={`${activity.length} 条记录`}>
          <PreferenceRow title="本地记录" description="记录工具、应用、窗口号和操作时间。截图、界面文字及输入内容均不保存在日志中。"
            control={<>
              <button type="button" className="settings-outline" disabled={Boolean(busy)} onClick={() => void refreshActivity()}>刷新</button>
              <button type="button" className="settings-outline" disabled={Boolean(busy) || !activity.length} onClick={() => void clearActivity()}>清空</button>
            </>} />
          {activity.length === 0 ? (
            <div className="desktop-control-row">
              <p className="desktop-control-empty">还没有活动记录。</p>
            </div>
          ) : (
            <div className="desktop-control-list">
              {activity.slice(0, 20).map((row) => (
                <div className="desktop-control-app" key={row.id}>
                  <span className={`desktop-control-badge ${row.ok ? 'is-ok' : 'is-warn'}`}>
                    {row.ok ? '成功' : '失败'}
                  </span>
                  <div className="desktop-control-app-copy">
                    <strong>{activityLabel(row.tool)}{row.appName ? ` · ${row.appName}` : ''}</strong>
                    <span>
                      {formatActivityTime(row.at)}
                      {row.windowId != null ? ` · 窗口 ${row.windowId}` : ''}
                      {row.detail ? ` · ${row.detail}` : ''}
                      {row.code ? ` · ${row.code}` : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </PreferenceGroup>
      </div>}
    </div>
  );
}

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`switch ${checked ? 'is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function PermissionTile({
  icon,
  title,
  description,
  checked,
  supported,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  checked: boolean;
  supported: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const tone = !supported ? 'off' : checked ? 'ready' : 'pending';
  return <div className="desktop-permission-tile" data-tone={tone}>
    <div className="desktop-permission-head">
      <span className="desktop-permission-mark">{icon}</span>
      <h3>{title}</h3>
      <span className="desktop-permission-pill" data-tone={tone}>
        {!supported ? '不可用' : checked ? '已授权' : '待授权'}
      </span>
    </div>
    <p>{description}</p>
    {supported && <button type="button" className="settings-outline" disabled={disabled}
      aria-label={`在系统设置中管理${title}`} onClick={onClick}>
      <ExternalLink aria-hidden="true" />打开系统设置
    </button>}
  </div>;
}
