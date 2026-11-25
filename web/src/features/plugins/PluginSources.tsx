import { FolderOpen, Globe2, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { DetailDialog } from '../../shared/DetailDialog';
import { LoadingState } from '../../shared/LoadingState';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { useSettingsToast } from '../../shared/SettingsToast';
import { errorText } from '../../shared/error-text';
import type { ModalDismiss } from '../../shared/useModalDialog';
import type { PluginMarketSource } from '../../types/global';

export function PluginSources({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const showToast = useSettingsToast();
  const confirmation = useActionConfirmation();
  const [sources, setSources] = useState<PluginMarketSource[]>();
  const [error, setError] = useState('');
  const [request, setRequest] = useState(0);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let current = true;
    setError('');
    void window.piApi.pluginSources().then(
      value => { if (current) setSources(value); },
      reason => { if (current) setError(errorText(reason)); },
    );
    return () => { current = false; };
  }, [request]);

  async function toggle(source: PluginMarketSource) {
    if (busy || source.builtin) return;
    setBusy(true);
    try {
      const next = await window.piApi.setPluginSourceEnabled({ id: source.id, enabled: !source.enabled });
      setSources(current => current?.map(item => item.id === next.id ? next : item));
      onChanged();
      showToast(next.enabled ? '插件源已启用' : '插件源已停用');
    } catch (error) {
      showToast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(source: PluginMarketSource) {
    if (busy || source.builtin) return;
    const accepted = await confirmation.confirm({
      title: `移除插件源「${source.name}」？`,
      description: '移除后，插件目录将停止读取该来源。已经安装的插件仍可使用。',
      confirmLabel: '移除来源',
      tone: 'danger',
    });
    if (!accepted) return;
    setBusy(true);
    try {
      await window.piApi.removePluginSource(source.id);
      setSources(current => current?.filter(item => item.id !== source.id));
      onChanged();
      showToast('插件源已移除');
    } catch (error) {
      showToast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <DetailDialog label="插件源" className="plugin-package-dialog" onClose={onClose} dismissable={!busy}>{close => <>
      <header className="detail-header">
        <div className="detail-heading"><span className="detail-icon"><Globe2 aria-hidden="true" /></span>
          <div><h2>插件源</h2><p>选择在插件目录中显示的来源。</p></div>
        </div>
        <button type="button" className="icon-button" disabled={busy} aria-label="关闭" onClick={close}><X aria-hidden="true" /></button>
      </header>
      <div className="detail-body plugin-package-body">
        {sources ? <ul className="plugin-source-list" aria-label="已配置的来源">
          {sources.map(source => <li key={source.id}>
            <div>
              <strong>{source.name}</strong>
              <small>{source.builtin ? '内置来源' : source.type === 'directory' ? '本地目录' : 'Registry JSON'}</small>
              {!source.builtin && <code>{source.location}</code>}
            </div>
            {!source.builtin && <div className="plugin-source-actions">
              <button type="button" role="switch" aria-checked={source.enabled} aria-label={`启用来源 ${source.name}`}
                className={`switch${source.enabled ? ' is-on' : ''}`} disabled={busy} onClick={() => void toggle(source)}><span /></button>
              <button type="button" className="icon-button" disabled={busy}
                aria-label={`移除来源 ${source.name}`} title="移除来源" onClick={() => void remove(source)}><Trash2 aria-hidden="true" /></button>
            </div>}
          </li>)}
        </ul> : error ? <div className="plugin-source-load-error">
          <p className="settings-error" role="alert">{error}</p>
          <button className="settings-outline" type="button" onClick={() => setRequest(value => value + 1)}>重新读取</button>
        </div> : <LoadingState variant="section">正在读取插件源…</LoadingState>}
      </div>
      <footer className="detail-footer plugin-package-footer">
        <span />
        <button type="button" className="settings-outline" disabled={busy} onClick={close}>完成</button>
        <button type="button" className="settings-save" disabled={busy || !sources} onClick={() => setAdding(true)}><Plus aria-hidden="true" />添加来源</button>
      </footer>
    </>}</DetailDialog>
    {adding && <AddPluginSourceDialog onClose={() => setAdding(false)} onAdded={source => {
      setSources(current => [...(current ?? []), source]);
      setAdding(false);
      onChanged();
      showToast('插件源已添加');
    }} />}
    {confirmation.dialog}
  </>;
}

export function AddPluginSourceDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (source: PluginMarketSource) => void }) {
  const locationId = useId();
  const [type, setType] = useState<'registry' | 'directory'>('registry');
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');

  function changeType(next: typeof type) {
    if (type === next) return;
    setType(next);
    setLocation('');
    setError('');
  }

  async function pick() {
    setPicking(true);
    setError('');
    try {
      const location = type === 'directory' ? await window.piApi.pickPluginSourceDirectory() : await window.piApi.pickPluginRegistryFile();
      if (location) setLocation(location);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPicking(false);
    }
  }

  async function save(dismiss: ModalDismiss) {
    if (busy || picking || !location.trim()) return;
    setBusy(true);
    setError('');
    try {
      const source = await window.piApi.addPluginSource({ name: name.trim() || undefined, type, location: location.trim() });
      await dismiss(() => onAdded(source));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return <SettingsDialog wide className="plugin-form-dialog" title="添加插件源" description="从 Registry JSON 或本地目录读取插件。"
    action="添加来源" busyAction="正在添加…" busy={busy} loading={false} unavailable={picking || !location.trim()}
    autoFocusFirstField={false} error={error || null} onClose={onClose} onSubmit={dismiss => void save(dismiss)}>
    <div className="plugin-flat-form plugin-source-fields">
      <div className="plugin-source-top-row">
        <div className="plugin-source-field">
          <span className="plugin-source-field-label">来源类型</span>
          <div className="settings-segments" role="group" aria-label="插件源类型">
            <button type="button" aria-pressed={type === 'registry'} disabled={picking} onClick={() => changeType('registry')}>Registry JSON</button>
            <button type="button" aria-pressed={type === 'directory'} disabled={picking} onClick={() => changeType('directory')}>本地目录</button>
          </div>
        </div>
        <label>
          <span>显示名称</span>
          <input value={name} maxLength={120} placeholder="可选" onChange={event => setName(event.target.value)} />
        </label>
      </div>
      <div className="plugin-source-field">
        <label htmlFor={locationId}>来源地址</label>
        <div className="plugin-source-location">
          <input id={locationId} value={location} disabled={picking} autoComplete="off" spellCheck={false}
            placeholder={type === 'directory' ? '插件所在的目录路径' : 'HTTPS 地址或本地 JSON 路径'}
            onChange={event => { setLocation(event.target.value); setError(''); }} />
          <button type="button" className="settings-outline" disabled={picking} onClick={() => void pick()}>
            <FolderOpen aria-hidden="true" />选择
          </button>
        </div>
      </div>
    </div>
  </SettingsDialog>;
}
