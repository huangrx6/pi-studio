import { useEffect, useRef, useState } from 'react';
import { Globe, Laptop, RefreshCw, SlidersHorizontal, Wifi } from 'lucide-react';
import { PreferenceGroup } from '../../shared/PreferenceGroup';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { LoadingState } from '../../shared/LoadingState';
import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { useSettingsToast } from '../../shared/SettingsToast';
import { errorText } from '../../shared/error-text';
import type { NetworkSettings as Settings, NetworkRoute } from '../../types/network-types';
import './styles/network-settings.css';

const system: Settings = { mode: 'system', proxyUrl: '', bypassRules: '' };
const modes = [
  { value: 'system', title: '跟随系统', description: '自动使用本机的系统代理与 PAC 配置', Icon: Laptop },
  { value: 'manual', title: '手动配置', description: '为 Pi Studio 指定代理地址与例外规则', Icon: SlidersHorizontal },
  { value: 'direct', title: '直接连接', description: 'Pi Studio 的请求直接发出，不经代理', Icon: Globe },
] as const;

export function NetworkSettings() {
  const showToast = useSettingsToast();
  const [saved, setSaved] = useState<Settings>();
  const [draft, setDraft] = useState<Settings>();
  const [busy, setBusy] = useState('load');
  const [loadError, setLoadError] = useState('');
  const [fieldError, setFieldError] = useState<{ field: 'proxy' | 'bypass'; message: string }>();
  const proxyInput = useRef<HTMLInputElement>(null);
  const bypassInput = useRef<HTMLInputElement>(null);
  const [detected, setDetected] = useState<NetworkRoute>();
  const [detectError, setDetectError] = useState('');
  const generation = useRef(0);
  const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));
  useSettingsDraftGuard({ label: '网络代理', dirty });

  async function load() {
    const id = ++generation.current;
    setBusy('load'); setLoadError('');
    try {
      const settings = await window.piApi.networkSettings();
      if (id !== generation.current) return;
      setSaved(settings); setDraft(settings);
      setBusy('detect');
      try {
        const route = await window.piApi.detectNetworkProxy(system);
        if (id === generation.current) { setDetected(route); setDetectError(''); }
      } catch (failure) {
        if (id === generation.current) setDetectError(errorText(failure));
      }
    } catch (failure) {
      if (id === generation.current) setLoadError(errorText(failure));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  useEffect(() => { void load(); return () => { ++generation.current; }; }, []);
  useEffect(() => {
    if (!busy && fieldError) (fieldError.field === 'proxy' ? proxyInput : bypassInput).current?.focus();
  }, [busy, fieldError]);

  function change(patch: Partial<Settings>) {
    setDraft(current => current ? { ...current, ...patch } : current);
    setFieldError(undefined);
  }

  async function act(action: 'save' | 'detect' | 'test') {
    if (busy || !draft) return;
    const id = ++generation.current;
    setBusy(action); setFieldError(undefined);
    try {
      if (action === 'save') {
        const next = await window.piApi.saveNetworkSettings(draft);
        if (id !== generation.current) return;
        setSaved(next); setDraft(next); showToast('已保存，后续请求将使用新的代理设置。');
      } else if (action === 'detect') {
        const route = await window.piApi.detectNetworkProxy(system);
        if (id !== generation.current) return;
        setDetected(route); setDetectError('');
      } else {
        const test = await window.piApi.testNetworkConnection(draft);
        if (id !== generation.current) return;
        const result = test.ok ? '连接成功' : `已连接，但服务返回 HTTP ${test.status}`;
        showToast(`${result} · ${test.latencyMs} ms · ${test.route === 'DIRECT' ? '直接连接' : test.route}`, test.ok ? 'success' : 'info');
      }
    } catch (failure) {
      if (id !== generation.current) return;
      const message = errorText(failure);
      if (action === 'detect') setDetectError(message);
      else if (draft.mode === 'manual' && /不使用代理的地址|例外地址/.test(message)) setFieldError({ field: 'bypass', message });
      else if (draft.mode === 'manual' && /代理地址|代理协议|代理端口|用户名或密码/.test(message)) setFieldError({ field: 'proxy', message });
      else showToast(message, 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  return <div className="settings-preference-page network-settings">
    <SettingsPageHeader title="网络代理" iconPosition="end"
      meta="设置模型请求、模型列表及技能与扩展下载的连接方式。"
      icon={<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round">
        <circle cx="16" cy="16" r="12" /><ellipse cx="16" cy="16" rx="5.5" ry="12" />
        <path d="M4 16h24" /><circle cx="21.5" cy="16" r="2.5" fill="var(--accent)" stroke="none" />
      </svg>} />
    {!draft && busy && <LoadingState variant="section">正在读取代理设置…</LoadingState>}
    {!draft && !busy && <div className="network-load-error">
      {loadError && <p role="alert">{loadError}</p>}
      <button type="button" className="settings-outline" onClick={() => void load()}>重新加载</button>
    </div>}
    {draft && <div className="settings-preference-groups">
      <PreferenceGroup title="连接方式">
        <form onSubmit={event => { event.preventDefault(); void act('save'); }}>
          <fieldset className="network-mode-fieldset" disabled={Boolean(busy)}>
            <legend className="sr-only">连接方式</legend>
            <div className="network-modes">
              {modes.map(({ value, title, description, Icon }) => {
                const selected = draft.mode === value;
                return <label key={value} className={`network-mode ${selected ? 'is-selected' : ''}`}>
                  <input type="radio" name="proxy-mode" value={value} checked={selected} onChange={() => change({ mode: value })} />
                  <span className="network-mode-head">
                    <span className="network-mode-icon" aria-hidden="true"><Icon /></span>
                    <strong>{title}</strong>
                  </span>
                  <small>{description}</small>
                </label>;
              })}
            </div>
          </fieldset>
          {draft.mode === 'manual' && <fieldset className="network-manual" disabled={Boolean(busy)}>
            <legend className="sr-only">手动代理配置</legend>
            <div className="network-manual-grid">
              <label className="network-field">
                <span className="network-field-head">
                  <span>代理地址</span>
                  {detected?.detectedProxyUrl && <button type="button" className="network-detect-fill"
                    onClick={() => change({ proxyUrl: detected.detectedProxyUrl })}>使用检测到的地址</button>}
                </span>
                <input ref={proxyInput} aria-label="代理地址" aria-invalid={fieldError?.field === 'proxy' || undefined}
                  aria-describedby={fieldError?.field === 'proxy' ? 'proxy-help proxy-error' : 'proxy-help'}
                  type="url" required value={draft.proxyUrl} placeholder="http://127.0.0.1:7897" autoComplete="off" spellCheck={false} onChange={event => change({ proxyUrl: event.target.value })} />
                <small id="proxy-help">支持 HTTP、HTTPS 和 SOCKS5，请使用免密码的代理地址。</small>
                {fieldError?.field === 'proxy' && <span id="proxy-error" className="network-field-error" role="alert">{fieldError.message}</span>}
              </label>
              <label className="network-field">
                <span>不使用代理的地址 <small>可选</small></span>
                <input ref={bypassInput} aria-label="不使用代理的地址" aria-invalid={fieldError?.field === 'bypass' || undefined}
                  aria-describedby={fieldError?.field === 'bypass' ? 'bypass-help bypass-error' : 'bypass-help'}
                  value={draft.bypassRules} placeholder="*.local, 192.168.0.0/16" autoComplete="off" spellCheck={false} onChange={event => change({ bypassRules: event.target.value })} />
                <small id="bypass-help">多个地址用逗号分隔。本机回环地址始终直接连接。</small>
                {fieldError?.field === 'bypass' && <span id="bypass-error" className="network-field-error" role="alert">{fieldError.message}</span>}
              </label>
            </div>
          </fieldset>}

          <div className="network-actions">
            <span className="network-help">{dirty ? '有未保存的更改' : '终端命令和外部浏览器使用各自的网络设置。'}</span>
            <button type="submit" className="settings-save" disabled={Boolean(busy) || !dirty}>{busy === 'save' ? '正在保存…' : '保存设置'}</button>
          </div>
        </form>
      </PreferenceGroup>

      <PreferenceGroup title="连接诊断">
        <div className="network-diagnostics-grid">
          <div className="network-diagnostic-tile">
            <div className="network-diagnostic-copy">
              <h3>本机代理</h3>
              <p>系统为访问 Google 选择的线路。</p>
              {detected && !detectError && <code className="network-route">{detected.route === 'DIRECT' ? '直接连接' : detected.route}</code>}
              {detectError && <p className="network-field-error" role="alert">{detectError}</p>}
            </div>
            <button type="button" className="settings-outline" disabled={Boolean(busy)} onClick={() => void act('detect')}>
              <RefreshCw className={busy === 'detect' ? 'spin' : undefined} aria-hidden="true" />
              {busy === 'detect' ? '正在识别…' : '重新识别'}
            </button>
          </div>
          <div className="network-diagnostic-tile">
            <div className="network-diagnostic-copy">
              <h3>连接测试</h3>
              <p>用当前设置访问 Google 检查连通性。测试不会发送密钥或对话内容。</p>
            </div>
            <button type="button" className="settings-outline" disabled={Boolean(busy)} onClick={() => void act('test')}>
              <Wifi aria-hidden="true" />
              {busy === 'test' ? '正在测试…' : '测试连接'}
            </button>
          </div>
        </div>
      </PreferenceGroup>
    </div>}
  </div>;
}
