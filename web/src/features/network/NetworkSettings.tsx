import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Globe, Monitor, RotateCw, SlidersHorizontal, Wifi } from 'lucide-react';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { LoadingState } from '../../shared/LoadingState';
import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { errorText } from '../../shared/error-text';
import type { NetworkSettings as Settings, NetworkRoute, NetworkTestResult } from '../../types/network-types';
import './styles/network-settings.css';

const system: Settings = { mode: 'system', proxyUrl: '', bypassRules: '' };
const modes = [
  { value: 'system', title: '跟随系统', description: '自动使用本机的系统代理与 PAC 配置', Icon: Monitor },
  { value: 'manual', title: '手动配置', description: '为 Pi Studio 指定代理地址', Icon: SlidersHorizontal },
  { value: 'direct', title: '直接连接', description: 'Pi Studio 的请求不使用代理', Icon: ArrowRight },
] as const;

export function NetworkSettings() {
  const [saved, setSaved] = useState<Settings>();
  const [draft, setDraft] = useState<Settings>();
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [detected, setDetected] = useState<NetworkRoute>();
  const [detectError, setDetectError] = useState('');
  const [result, setResult] = useState<NetworkTestResult>();
  const generation = useRef(0);
  const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));
  useSettingsDraftGuard({ label: '网络代理', dirty });

  async function load() {
    const id = ++generation.current;
    setBusy('load'); setError('');
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
      if (id === generation.current) setError(errorText(failure));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  useEffect(() => { void load(); return () => { ++generation.current; }; }, []);

  function change(patch: Partial<Settings>) {
    setDraft(current => current ? { ...current, ...patch } : current);
    setResult(undefined); setError(''); setNotice('');
  }

  async function act(action: 'save' | 'detect' | 'test') {
    if (busy || !draft) return;
    const id = ++generation.current;
    setBusy(action); setError(''); setNotice('');
    if (action === 'test') setResult(undefined);
    try {
      if (action === 'save') {
        const next = await window.piApi.saveNetworkSettings(draft);
        if (id !== generation.current) return;
        setSaved(next); setDraft(next); setNotice('已保存，后续请求将使用新的代理设置。');
      } else if (action === 'detect') {
        const route = await window.piApi.detectNetworkProxy(system);
        if (id !== generation.current) return;
        setDetected(route); setDetectError('');
      } else {
        const test = await window.piApi.testNetworkConnection(draft);
        if (id === generation.current) setResult(test);
      }
    } catch (failure) {
      if (id !== generation.current) return;
      if (action === 'detect') setDetectError(errorText(failure));
      else setError(errorText(failure));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  return <div className="network-settings">
    <SettingsPageHeader
      icon={<Globe />}
      title="网络代理"
      meta={<span>作用于模型请求、模型列表以及技能与扩展下载</span>}
    />
    {!draft && busy && <LoadingState variant="section">正在读取代理设置…</LoadingState>}
    {!draft && !busy && <button type="button" className="settings-outline" onClick={() => void load()}>重新加载</button>}
    {draft && <form onSubmit={event => { event.preventDefault(); void act('save'); }}>
      <fieldset className="network-mode-fieldset" disabled={Boolean(busy)}>
        <legend>连接方式</legend>
        <div className="network-modes">
          {modes.map(({ value, title, description, Icon }) => <label key={value} className={`network-mode ${draft.mode === value ? 'is-selected' : ''}`}>
            <input type="radio" name="proxy-mode" value={value} checked={draft.mode === value} onChange={() => change({ mode: value })} />
            <Icon aria-hidden="true" />
            <span><strong>{title}</strong><small>{description}</small></span>
            {draft.mode === value && <Check className="network-mode-check" aria-hidden="true" />}
          </label>)}
        </div>
      </fieldset>

      {draft.mode === 'manual' && <fieldset className="network-manual network-card" disabled={Boolean(busy)}>
        <legend className="sr-only">手动代理配置</legend>
        <label className="network-field">
          <span>代理地址</span>
          <input aria-label="代理地址" type="url" required value={draft.proxyUrl} placeholder="http://127.0.0.1:7897" autoComplete="off" spellCheck={false} onChange={event => change({ proxyUrl: event.target.value })} />
          <small>支持 HTTP、HTTPS 和 SOCKS5；使用无需账号密码的代理入口。</small>
        </label>
        {detected?.detectedProxyUrl && <button type="button" className="settings-outline" onClick={() => change({ proxyUrl: detected.detectedProxyUrl })}>使用检测到的地址</button>}
        <label className="network-field">
          <span>不使用代理的地址 <small>可选</small></span>
          <input aria-label="不使用代理的地址" value={draft.bypassRules} placeholder="*.local, 192.168.0.0/16" autoComplete="off" spellCheck={false} onChange={event => change({ bypassRules: event.target.value })} />
          <small>多个地址用逗号分隔。本机回环地址始终直接连接。</small>
        </label>
      </fieldset>}

      <section className="network-card network-detection" aria-label="本机代理识别">
        <div className="network-card-heading"><div><h2>本机代理</h2><p>访问 Google 时，系统选择的连接线路。</p></div>
          <button type="button" className="settings-outline" disabled={Boolean(busy)} onClick={() => void act('detect')}><RotateCw aria-hidden="true" />{busy === 'detect' ? '正在识别…' : '重新识别'}</button>
        </div>
        {detected && !detectError && <div className="network-route"><Monitor aria-hidden="true" /><span>{detected.route === 'DIRECT' ? '直接连接 · 系统未为此地址指定代理' : detected.route}</span></div>}
        {detectError && <p className="network-message is-error" role="alert">{detectError}</p>}
        <p className="network-help">跟随系统会自动采用本机代理和 PAC 规则；也可以将识别到的地址填入手动配置。</p>
      </section>

      <section className="network-card" aria-label="连接测试">
        <div className="network-card-heading"><div><h2>连接测试</h2><p>使用当前填写的配置访问 Google 免密钥连通性检测地址，不发送密钥或对话内容。</p></div>
          <button type="button" className="settings-outline" disabled={Boolean(busy)} onClick={() => void act('test')}><Wifi aria-hidden="true" />{busy === 'test' ? '正在测试…' : '测试连接'}</button>
        </div>
        {result && <div className={`network-message ${result.ok ? 'is-success' : 'is-error'}`} role="status">
          <strong>{result.ok ? '连接成功' : `已连接，但服务返回 HTTP ${result.status}`}</strong>
          <span>{result.latencyMs} ms · {result.route === 'DIRECT' ? '直接连接' : result.route}</span>
        </div>}
        <p className="network-help">测试不会保存设置或调用模型。{dirty ? '当前有未保存的更改。' : ''}</p>
      </section>

      <div className="network-actions">
        <span className="network-help">仅对 Pi Studio 生效，保存后无需重启。</span>
        <button type="submit" className="settings-save" disabled={Boolean(busy) || !dirty}>{busy === 'save' ? '正在保存…' : '保存设置'}</button>
      </div>
      <p className="network-help network-scope">终端命令、外部浏览器和使用独立连接方式的服务仍使用各自的网络设置。</p>
    </form>}
    {notice && <p className="network-message is-success" role="status">{notice}</p>}
    {error && <p className="network-message is-error" role="alert">{error}</p>}
  </div>;
}
