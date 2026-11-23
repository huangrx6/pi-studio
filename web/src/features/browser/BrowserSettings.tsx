import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, AppWindow, Contact, Download, ExternalLink, Eye, EyeOff,
  FolderOpen, Globe, History, KeyRound, Link2, Package, Plus,
  Sparkles, TerminalSquare, Trash2,
} from 'lucide-react';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { LoadingState } from '../../shared/LoadingState';
import { errorText } from '../../shared/error-text';
import './styles/browser-settings.css';

type BrowserPreferences = {
  agentControlEnabled: boolean;
  showFullUrl: boolean;
  webLinkOpenTarget: string;
  localLinkOpenTarget: string;
  annotatedScreenshots: string;
  askDownloadPath: boolean;
  downloadDirectory: string;
  historyAccess: string;
  evaluateEnabled: boolean;
  cdpEnabled: boolean;
  externalChromeEnabled: boolean;
  externalChromeEndpoint: string;
  defaultDownloadDirectory?: string;
};

type SitePolicy = {
  id: string;
  originPattern: string;
  actionClass: string;
  decision: string;
  note?: string;
};

type ExternalTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
};

type PasswordRow = {
  id: string;
  origin: string;
  username: string;
  note?: string;
  updatedAt?: number;
};

type ContactRow = {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  updatedAt?: number;
};

type ExtensionRow = {
  id: string;
  name: string;
  version?: string;
  path?: string;
  enabled?: boolean;
  loaded?: boolean;
};

const ACTION_OPTIONS = [
  { value: 'navigate', label: '浏览' },
  { value: 'read', label: '读取' },
  { value: 'act', label: '操作' },
  { value: 'download', label: '下载' },
  { value: 'dialog', label: '对话框' },
  { value: 'evaluate', label: '脚本' },
  { value: 'cdp', label: 'CDP' },
] as const;

const DECISION_OPTIONS = [
  { value: 'allow', label: '允许' },
  { value: 'ask', label: '需要批准' },
  { value: 'deny', label: '拒绝' },
] as const;

const emptyPrefs = (): BrowserPreferences => ({
  agentControlEnabled: true,
  showFullUrl: false,
  webLinkOpenTarget: 'workbench',
  localLinkOpenTarget: 'workbench',
  annotatedScreenshots: 'always',
  askDownloadPath: false,
  downloadDirectory: '',
  historyAccess: 'ask',
  evaluateEnabled: false,
  cdpEnabled: false,
  externalChromeEnabled: false,
  externalChromeEndpoint: 'http://127.0.0.1:9222',
});

export function BrowserSettings({ onOpenBrowser }: { onOpenBrowser?: () => void } = {}) {
  const sectionId = useId();
  const [prefs, setPrefs] = useState<BrowserPreferences | null>(null);
  const [policies, setPolicies] = useState<SitePolicy[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [policyDraft, setPolicyDraft] = useState({ originPattern: '', actionClass: 'act', decision: 'allow' });
  const [externalTargets, setExternalTargets] = useState<ExternalTarget[]>([]);
  const [externalWarning, setExternalWarning] = useState('');
  const [externalEndpointLabel, setExternalEndpointLabel] = useState('');
  const [passwords, setPasswords] = useState<PasswordRow[]>([]);
  const [passwordAvailable, setPasswordAvailable] = useState(true);
  const [passwordDraft, setPasswordDraft] = useState({ origin: '', username: '', password: '', note: '' });
  const [revealedPasswordId, setRevealedPasswordId] = useState('');
  const [revealedPasswordValue, setRevealedPasswordValue] = useState('');
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [contactDraft, setContactDraft] = useState({ name: '', phone: '', email: '', address: '' });
  const [extensions, setExtensions] = useState<ExtensionRow[]>([]);
  const [extensionsSupported, setExtensionsSupported] = useState(true);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const id = ++generation.current;
    setBusy('load');
    setError('');
    try {
      const [settings, policyResult, passwordResult, contactResult, extensionResult] = await Promise.all([
        window.piApi.browserAdvancedSettings(),
        window.piApi.browserSitePolicies(),
        window.piApi.browserPasswords().catch(() => ({ ok: false, passwords: [], available: false })),
        window.piApi.browserContacts().catch(() => ({ ok: false, contacts: [] })),
        window.piApi.browserExtensions().catch(() => ({ ok: false, extensions: [], supported: false })),
      ]);
      if (id !== generation.current) return;
      setPrefs({ ...emptyPrefs(), ...settings });
      setPolicies(Array.isArray(policyResult?.policies) ? policyResult.policies as SitePolicy[] : []);
      setPasswords(Array.isArray(passwordResult?.passwords) ? passwordResult.passwords as PasswordRow[] : []);
      setPasswordAvailable(passwordResult?.available !== false);
      setContacts(Array.isArray(contactResult?.contacts) ? contactResult.contacts as ContactRow[] : []);
      setExtensions(Array.isArray(extensionResult?.extensions) ? extensionResult.extensions as ExtensionRow[] : []);
      setExtensionsSupported(extensionResult?.supported !== false);
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  async function patch(partial: Partial<BrowserPreferences>, confirmMessage?: string) {
    if (!prefs || busy) return;
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    const id = ++generation.current;
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const result = await window.piApi.browserSetPreferences(partial);
      if (id !== generation.current) return;
      const next = { ...emptyPrefs(), ...(result.preferences || result) };
      setPrefs(next);
      setNotice('已保存');
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function clearData() {
    if (!window.confirm('清除内嵌浏览器的 Cookie、缓存、站点数据和历史？下载的文件会保留。')) return;
    const id = ++generation.current;
    setBusy('clear');
    setError('');
    setNotice('');
    try {
      await window.piApi.browserClearData();
      if (id === generation.current) setNotice('已清除浏览数据');
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function pickDownloadDir() {
    const id = ++generation.current;
    setBusy('folder');
    setError('');
    try {
      const result = await window.piApi.browserPickDownloadDirectory();
      if (id !== generation.current) return;
      if (result.ok && result.preferences) {
        setPrefs({ ...emptyPrefs(), ...result.preferences });
        setNotice(`下载目录：${result.path}`);
      }
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function addPolicy() {
    const originPattern = policyDraft.originPattern.trim();
    if (!originPattern) {
      setError('请填写网站或模式，例如 example.com 或 *.example.com');
      return;
    }
    const id = ++generation.current;
    setBusy('policy');
    setError('');
    try {
      const result = await window.piApi.browserSitePolicyUpsert({
        originPattern,
        actionClass: policyDraft.actionClass,
        decision: policyDraft.decision,
      });
      if (id !== generation.current) return;
      setPolicies(Array.isArray(result.policies) ? result.policies as SitePolicy[] : []);
      setPolicyDraft((current) => ({ ...current, originPattern: '' }));
      setNotice('已更新网站权限');
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function removePolicy(row: SitePolicy) {
    const id = ++generation.current;
    setBusy('policy');
    try {
      const result = await window.piApi.browserSitePolicyRemove({
        id: row.id,
        originPattern: row.originPattern,
        actionClass: row.actionClass,
      });
      if (id !== generation.current) return;
      setPolicies(Array.isArray(result.policies) ? result.policies as SitePolicy[] : []);
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function refreshExternal() {
    const id = ++generation.current;
    setBusy('external');
    setError('');
    setExternalWarning('');
    try {
      const result = await window.piApi.browserExternalTargets();
      if (id !== generation.current) return;
      setExternalTargets(Array.isArray(result.targets) ? result.targets : []);
      setExternalEndpointLabel(result.endpoint || '');
      setExternalWarning(result.warning || '');
      setNotice(result.ok ? `已发现 ${result.targets?.length || 0} 个页面目标` : '未连接');
    } catch (cause) {
      if (id === generation.current) {
        setExternalTargets([]);
        setError(errorText(cause));
      }
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function attachExternal(targetId: string) {
    const id = ++generation.current;
    setBusy('external');
    setError('');
    try {
      const result = await window.piApi.browserExternalAttach({ targetId });
      if (id !== generation.current) return;
      setNotice(result.ok ? '已连接到外部 Chrome 标签' : '连接失败');
      if (result.warning) setExternalWarning(String(result.warning));
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function detachExternal() {
    const id = ++generation.current;
    setBusy('external');
    try {
      await window.piApi.browserExternalDetach({});
      if (id === generation.current) setNotice('已断开全部外接会话');
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function savePassword() {
    const origin = passwordDraft.origin.trim();
    const username = passwordDraft.username.trim();
    if (!origin || !username || !passwordDraft.password) {
      setError('请填写网站、用户名和密码');
      return;
    }
    const id = ++generation.current;
    setBusy('password');
    setError('');
    try {
      const result = await window.piApi.browserPasswordUpsert({
        origin,
        username,
        password: passwordDraft.password,
        note: passwordDraft.note,
      });
      if (id !== generation.current) return;
      setPasswords(Array.isArray(result.passwords) ? result.passwords as PasswordRow[] : []);
      setPasswordDraft({ origin: '', username: '', password: '', note: '' });
      setRevealedPasswordId('');
      setRevealedPasswordValue('');
      setNotice('已保存密码');
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function removePassword(row: PasswordRow) {
    if (!window.confirm(`删除 ${row.origin} 上 ${row.username} 的保存密码？`)) return;
    const id = ++generation.current;
    setBusy('password');
    setError('');
    try {
      const result = await window.piApi.browserPasswordRemove({ id: row.id });
      if (id !== generation.current) return;
      setPasswords(Array.isArray(result.passwords) ? result.passwords as PasswordRow[] : []);
      if (revealedPasswordId === row.id) {
        setRevealedPasswordId('');
        setRevealedPasswordValue('');
      }
      setNotice('已删除密码');
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function toggleRevealPassword(row: PasswordRow) {
    if (revealedPasswordId === row.id) {
      setRevealedPasswordId('');
      setRevealedPasswordValue('');
      return;
    }
    const id = ++generation.current;
    setBusy('password');
    setError('');
    try {
      const result = await window.piApi.browserPasswordReveal({ id: row.id });
      if (id !== generation.current) return;
      setRevealedPasswordId(row.id);
      setRevealedPasswordValue(result.password?.password || '');
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function copyRevealedPassword() {
    if (!revealedPasswordValue) return;
    try {
      await navigator.clipboard.writeText(revealedPasswordValue);
      setNotice('密码已复制到剪贴板');
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function saveContact() {
    const name = contactDraft.name.trim();
    if (!name) {
      setError('请填写联系人姓名');
      return;
    }
    const id = ++generation.current;
    setBusy('contact');
    setError('');
    try {
      const result = await window.piApi.browserContactUpsert({ ...contactDraft, name });
      if (id !== generation.current) return;
      setContacts(Array.isArray(result.contacts) ? result.contacts as ContactRow[] : []);
      setContactDraft({ name: '', phone: '', email: '', address: '' });
      setNotice('已保存联系信息');
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function removeContact(row: ContactRow) {
    if (!window.confirm(`删除联系人 ${row.name}？`)) return;
    const id = ++generation.current;
    setBusy('contact');
    setError('');
    try {
      const result = await window.piApi.browserContactRemove({ id: row.id });
      if (id !== generation.current) return;
      setContacts(Array.isArray(result.contacts) ? result.contacts as ContactRow[] : []);
      setNotice('已删除联系人');
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function loadExtension() {
    const id = ++generation.current;
    setBusy('extension');
    setError('');
    try {
      const result = await window.piApi.browserExtensionLoad({});
      if (id !== generation.current) return;
      if (result.cancelled) return;
      setExtensions(Array.isArray(result.extensions) ? result.extensions as ExtensionRow[] : []);
      setNotice(result.ok ? '已加载扩展' : '未能加载扩展');
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function removeExtension(row: ExtensionRow) {
    if (!window.confirm(`移除扩展「${row.name}」？`)) return;
    const id = ++generation.current;
    setBusy('extension');
    setError('');
    try {
      const result = await window.piApi.browserExtensionRemove({ id: row.id, path: row.path });
      if (id !== generation.current) return;
      setExtensions(Array.isArray(result.extensions) ? result.extensions as ExtensionRow[] : []);
      setNotice('已移除扩展');
    } catch (cause) {
      if (id === generation.current) setError(errorText(cause));
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  const disabled = Boolean(busy);

  return (
    <div className="browser-settings">
      <SettingsPageHeader
        icon={<Globe />}
        title="浏览器"
        meta={<span>管理内置浏览器偏好、网站权限与高级调试</span>}
        actions={onOpenBrowser ? (
          <button type="button" className="settings-outline" onClick={onOpenBrowser}>
            <AppWindow aria-hidden="true" />打开工作台浏览器
          </button>
        ) : undefined}
      />

      {!prefs && busy && <LoadingState variant="section">正在读取浏览器设置…</LoadingState>}
      {!prefs && !busy && (
        <button type="button" className="settings-outline" onClick={() => void load()}>重新加载</button>
      )}

      {prefs && (
        <>
          <section className="browser-settings-card browser-settings-master" aria-labelledby={`${sectionId}-master`}>
            <div className="browser-settings-row">
              <div className="browser-settings-copy">
                <h2 id={`${sectionId}-master`}>浏览器</h2>
                <p>让 Agent 控制内置浏览器（需同时满足工具权限与网站策略）</p>
              </div>
              <label className="browser-toggle">
                <span className="sr-only">让 Agent 控制内置浏览器</span>
                <input
                  type="checkbox"
                  checked={prefs.agentControlEnabled}
                  disabled={disabled}
                  onChange={(event) => void patch({ agentControlEnabled: event.target.checked })}
                />
              </label>
            </div>
          </section>

          <section className="browser-settings-section" aria-labelledby={`${sectionId}-general`}>
            <h2 id={`${sectionId}-general`} className="browser-settings-section-title">常规</h2>
            <div className="browser-settings-card">
              <Row
                title="网页 URL 打开位置"
                description="对话与文档中的 http(s) 链接默认打开位置"
                control={(
                  <select
                    value={prefs.webLinkOpenTarget}
                    disabled={disabled}
                    aria-label="网页 URL 打开位置"
                    onChange={(event) => void patch({ webLinkOpenTarget: event.target.value })}
                  >
                    <option value="workbench">工作台浏览器</option>
                    <option value="system">系统浏览器</option>
                  </select>
                )}
              />
              <Row
                title="本地 URL 打开位置"
                description="本地开发站点与 file:// HTML 的默认打开位置"
                control={(
                  <select
                    value={prefs.localLinkOpenTarget}
                    disabled={disabled}
                    aria-label="本地 URL 打开位置"
                    onChange={(event) => void patch({ localLinkOpenTarget: event.target.value })}
                  >
                    <option value="workbench">工作台浏览器</option>
                    <option value="system">系统浏览器</option>
                  </select>
                )}
              />
              <Row
                title="显示完整网址"
                description="在地址栏中显示路径、查询参数和片段"
                control={(
                  <Toggle
                    checked={prefs.showFullUrl}
                    disabled={disabled}
                    label="显示完整网址"
                    onChange={(checked) => void patch({ showFullUrl: checked })}
                  />
                )}
              />
              <Row
                title="浏览数据"
                description="清除应用内浏览器中的 Cookie、缓存、站点存储和本机会话历史"
                control={(
                  <button type="button" className="settings-outline" disabled={disabled} onClick={() => void clearData()}>
                    <Trash2 aria-hidden="true" />{busy === 'clear' ? '清除中…' : '清除浏览数据'}
                  </button>
                )}
              />
              <Row
                title="浏览历史"
                description="在工作台浏览器菜单中查看；也可在此打开浏览器面板管理"
                control={(
                  <button type="button" className="settings-outline" disabled={!onOpenBrowser} onClick={() => onOpenBrowser?.()}>
                    <History aria-hidden="true" />管理
                  </button>
                )}
              />
              <Row
                title="批注截图"
                description="Agent 操作前在页面上圈出目标，便于你确认它在点哪里"
                control={(
                  <select
                    value={prefs.annotatedScreenshots}
                    disabled={disabled}
                    aria-label="批注截图"
                    onChange={(event) => void patch({ annotatedScreenshots: event.target.value })}
                  >
                    <option value="always">始终包含</option>
                    <option value="never">关闭</option>
                  </select>
                )}
              />
            </div>
          </section>

          <section className="browser-settings-section" aria-labelledby={`${sectionId}-download`}>
            <h2 id={`${sectionId}-download`} className="browser-settings-section-title">下载</h2>
            <div className="browser-settings-card">
              <Row
                title="位置"
                description={prefs.downloadDirectory || prefs.defaultDownloadDirectory || 'Studio 托管的下载目录'}
                control={(
                  <button type="button" className="settings-outline" disabled={disabled} onClick={() => void pickDownloadDir()}>
                    <Download aria-hidden="true" />更改
                  </button>
                )}
              />
              <Row
                title="下载前询问保存位置"
                description="开启后，每次下载都会弹出保存位置对话框"
                control={(
                  <Toggle
                    checked={prefs.askDownloadPath}
                    disabled={disabled}
                    label="下载前询问保存位置"
                    onChange={(checked) => void patch({ askDownloadPath: checked })}
                  />
                )}
              />
              <Row
                title="下载历史记录"
                description="在工作台浏览器的下载菜单中查看和管理"
                control={(
                  <button type="button" className="settings-outline" disabled={!onOpenBrowser} onClick={() => onOpenBrowser?.()}>
                    管理
                  </button>
                )}
              />
            </div>
          </section>

          <section className="browser-settings-section" aria-labelledby={`${sectionId}-autofill`}>
            <h2 id={`${sectionId}-autofill`} className="browser-settings-section-title">自动填充与密码</h2>
            <div className="browser-settings-card">
              <div className="browser-settings-manage-block">
                <div className="browser-settings-manage-head">
                  <div>
                    <h3><KeyRound aria-hidden="true" />保存的密码</h3>
                    <p>
                      {passwordAvailable
                        ? '密码仅保存在本机，经系统安全存储保护；不会发送给模型。'
                        : '当前环境无法使用安全存储，密码功能不可用。'}
                    </p>
                  </div>
                </div>
                <div className="browser-settings-manage-form browser-settings-password-form">
                  <input
                    value={passwordDraft.origin}
                    disabled={disabled || !passwordAvailable}
                    placeholder="网站，例如 example.com"
                    aria-label="密码对应网站"
                    onChange={(event) => setPasswordDraft((current) => ({ ...current, origin: event.target.value }))}
                  />
                  <input
                    value={passwordDraft.username}
                    disabled={disabled || !passwordAvailable}
                    placeholder="用户名"
                    aria-label="用户名"
                    onChange={(event) => setPasswordDraft((current) => ({ ...current, username: event.target.value }))}
                  />
                  <input
                    type="password"
                    value={passwordDraft.password}
                    disabled={disabled || !passwordAvailable}
                    placeholder="密码"
                    aria-label="密码"
                    onChange={(event) => setPasswordDraft((current) => ({ ...current, password: event.target.value }))}
                  />
                  <input
                    value={passwordDraft.note}
                    disabled={disabled || !passwordAvailable}
                    placeholder="备注（可选）"
                    aria-label="密码备注"
                    onChange={(event) => setPasswordDraft((current) => ({ ...current, note: event.target.value }))}
                  />
                  <button type="button" className="settings-outline" disabled={disabled || !passwordAvailable} onClick={() => void savePassword()}>
                    <Plus aria-hidden="true" />添加
                  </button>
                </div>
                {passwords.length === 0 ? (
                  <p className="browser-settings-empty">还没有保存的密码</p>
                ) : (
                  <ul className="browser-settings-manage-list">
                    {passwords.map((row) => (
                      <li key={row.id}>
                        <div>
                          <strong>{row.origin}</strong>
                          <small>{row.username}{row.note ? ` · ${row.note}` : ''}</small>
                          {revealedPasswordId === row.id && revealedPasswordValue && (
                            <code className="browser-settings-secret">{revealedPasswordValue}</code>
                          )}
                        </div>
                        <div className="browser-settings-manage-actions">
                          <button type="button" className="settings-text-button" disabled={disabled} onClick={() => void toggleRevealPassword(row)}>
                            {revealedPasswordId === row.id ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                            {revealedPasswordId === row.id ? '隐藏' : '显示'}
                          </button>
                          {revealedPasswordId === row.id && (
                            <button type="button" className="settings-text-button" disabled={disabled} onClick={() => void copyRevealedPassword()}>
                              复制
                            </button>
                          )}
                          <button type="button" className="settings-text-button" disabled={disabled} onClick={() => void removePassword(row)}>
                            删除
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          <section className="browser-settings-section" aria-labelledby={`${sectionId}-contacts`}>
            <h2 id={`${sectionId}-contacts`} className="browser-settings-section-title">联系信息</h2>
            <div className="browser-settings-card">
              <div className="browser-settings-manage-block">
                <div className="browser-settings-manage-head">
                  <div>
                    <h3><Contact aria-hidden="true" />地址与联系人</h3>
                    <p>保存在 Studio 本机，便于你在工作台中查阅；当前不会自动向网页填入。</p>
                  </div>
                </div>
                <div className="browser-settings-manage-form browser-settings-contact-form">
                  <input
                    value={contactDraft.name}
                    disabled={disabled}
                    placeholder="姓名"
                    aria-label="联系人姓名"
                    onChange={(event) => setContactDraft((current) => ({ ...current, name: event.target.value }))}
                  />
                  <input
                    value={contactDraft.phone}
                    disabled={disabled}
                    placeholder="电话"
                    aria-label="电话"
                    onChange={(event) => setContactDraft((current) => ({ ...current, phone: event.target.value }))}
                  />
                  <input
                    value={contactDraft.email}
                    disabled={disabled}
                    placeholder="邮箱"
                    aria-label="邮箱"
                    onChange={(event) => setContactDraft((current) => ({ ...current, email: event.target.value }))}
                  />
                  <input
                    value={contactDraft.address}
                    disabled={disabled}
                    placeholder="地址"
                    aria-label="地址"
                    onChange={(event) => setContactDraft((current) => ({ ...current, address: event.target.value }))}
                  />
                  <button type="button" className="settings-outline" disabled={disabled} onClick={() => void saveContact()}>
                    <Plus aria-hidden="true" />添加
                  </button>
                </div>
                {contacts.length === 0 ? (
                  <p className="browser-settings-empty">还没有联系信息</p>
                ) : (
                  <ul className="browser-settings-manage-list">
                    {contacts.map((row) => (
                      <li key={row.id}>
                        <div>
                          <strong>{row.name}</strong>
                          <small>{[row.phone, row.email, row.address].filter(Boolean).join(' · ') || '无附加信息'}</small>
                        </div>
                        <div className="browser-settings-manage-actions">
                          <button type="button" className="settings-text-button" disabled={disabled} onClick={() => void removeContact(row)}>
                            删除
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          <section className="browser-settings-section" aria-labelledby={`${sectionId}-extensions`}>
            <h2 id={`${sectionId}-extensions`} className="browser-settings-section-title">扩展程序</h2>
            <div className="browser-settings-card">
              <div className="browser-settings-manage-block">
                <div className="browser-settings-manage-head">
                  <div>
                    <h3><Package aria-hidden="true" />解压后的扩展</h3>
                    <p>
                      {extensionsSupported
                        ? '仅支持加载已解压的扩展目录（含 manifest.json），不会接入扩展商店。'
                        : '当前运行环境不支持加载浏览器扩展。'}
                    </p>
                  </div>
                  <button type="button" className="settings-outline" disabled={disabled || !extensionsSupported} onClick={() => void loadExtension()}>
                    <FolderOpen aria-hidden="true" />{busy === 'extension' ? '加载中…' : '加载扩展'}
                  </button>
                </div>
                {extensions.length === 0 ? (
                  <p className="browser-settings-empty">还没有已安装的扩展</p>
                ) : (
                  <ul className="browser-settings-manage-list">
                    {extensions.map((row) => (
                      <li key={row.id || row.path}>
                        <div>
                          <strong>{row.name}</strong>
                          <small>
                            {[row.version && `v${row.version}`, row.loaded ? '已加载' : '未加载', row.path]
                              .filter(Boolean)
                              .join(' · ')}
                          </small>
                        </div>
                        <div className="browser-settings-manage-actions">
                          <button type="button" className="settings-text-button" disabled={disabled} onClick={() => void removeExtension(row)}>
                            移除
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          <section className="browser-settings-section" aria-labelledby={`${sectionId}-perms`}>
            <h2 id={`${sectionId}-perms`} className="browser-settings-section-title">浏览器权限</h2>
            <div className="browser-settings-card">
              <Row
                title="历史记录"
                description="选择 Agent 是否可访问你的内置浏览器历史记录"
                control={(
                  <select
                    value={prefs.historyAccess}
                    disabled={disabled}
                    aria-label="历史记录访问"
                    onChange={(event) => void patch({ historyAccess: event.target.value })}
                  >
                    <option value="ask">始终询问</option>
                    <option value="allow">始终允许</option>
                    <option value="deny">拒绝</option>
                  </select>
                )}
              />
              <div className="browser-settings-policy-block">
                <div className="browser-settings-policy-head">
                  <div>
                    <h3>网站权限</h3>
                    <p>设置默认之外的站点例外。localhost 默认允许读取与操作；脚本与 CDP 默认拒绝。</p>
                  </div>
                </div>
                <div className="browser-settings-policy-form">
                  <input
                    value={policyDraft.originPattern}
                    disabled={disabled}
                    placeholder="example.com 或 *.example.com"
                    aria-label="网站或模式"
                    onChange={(event) => setPolicyDraft((current) => ({ ...current, originPattern: event.target.value }))}
                  />
                  <select
                    value={policyDraft.actionClass}
                    disabled={disabled}
                    aria-label="动作类型"
                    onChange={(event) => setPolicyDraft((current) => ({ ...current, actionClass: event.target.value }))}
                  >
                    {ACTION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <select
                    value={policyDraft.decision}
                    disabled={disabled}
                    aria-label="决策"
                    onChange={(event) => setPolicyDraft((current) => ({ ...current, decision: event.target.value }))}
                  >
                    {DECISION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <button type="button" className="settings-outline" disabled={disabled} onClick={() => void addPolicy()}>
                    <Link2 aria-hidden="true" />添加
                  </button>
                </div>
                {policies.length === 0 ? (
                  <p className="browser-settings-empty">此处仅显示设置了自定义权限的网站</p>
                ) : (
                  <table className="browser-settings-policy-table">
                    <thead>
                      <tr>
                        <th>网站或模式</th>
                        <th>动作</th>
                        <th>决策</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {policies.map((row) => (
                        <tr key={row.id}>
                          <td>{row.originPattern}</td>
                          <td>{labelForAction(row.actionClass)}</td>
                          <td>{labelForDecision(row.decision)}</td>
                          <td>
                            <button type="button" className="settings-text-button" disabled={disabled} onClick={() => void removePolicy(row)}>
                              删除
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>

          <section className="browser-settings-section" aria-labelledby={`${sectionId}-dev`}>
            <h2 id={`${sectionId}-dev`} className="browser-settings-section-title">开发者模式</h2>
            <div className="browser-settings-card browser-settings-danger">
              <div className="browser-settings-risk" role="status">
                <AlertTriangle aria-hidden="true" />
                <div>
                  <strong>风险升高</strong>
                  <p>完整 CDP 与外接 Chrome 可触及敏感页面状态。默认关闭；开启后仍需按站点授权。</p>
                </div>
              </div>
              <Row
                title="页面脚本求值"
                description="允许 Agent 在已授权站点执行页内脚本（browser_evaluate）"
                control={(
                  <Toggle
                    checked={prefs.evaluateEnabled}
                    disabled={disabled}
                    label="页面脚本求值"
                    onChange={(checked) => void patch(
                      { evaluateEnabled: checked },
                      checked ? '开启后，Agent 可在你授权的站点上执行页面脚本。确定开启？' : undefined,
                    )}
                  />
                )}
              />
              <Row
                title="启用完整 CDP 访问权限"
                description="允许在已连接的浏览器会话中使用完整 Chrome DevTools Protocol。可能使你的数据面临风险。"
                control={(
                  <Toggle
                    checked={prefs.cdpEnabled}
                    disabled={disabled}
                    label="完整 CDP"
                    onChange={(checked) => void patch(
                      { cdpEnabled: checked, ...(checked ? {} : { externalChromeEnabled: false }) },
                      checked
                        ? '开启完整 CDP 后，Agent 可检查并控制更底层的浏览器功能。请仅在你理解风险时开启。确定？'
                        : undefined,
                    )}
                  />
                )}
              />
              <Row
                title="外接本机 Chrome"
                description="连接到你用远程调试端口启动的 Chrome（不会同步系统日常配置文件）。需同时开启 CDP。"
                control={(
                  <Toggle
                    checked={prefs.externalChromeEnabled}
                    disabled={disabled || !prefs.cdpEnabled}
                    label="外接 Chrome"
                    onChange={(checked) => void patch(
                      { externalChromeEnabled: checked },
                      checked
                        ? '外接 Chrome 可触及该调试实例中的已登录会话。请确认调试端口只在本机、且你信任当前环境。确定开启？'
                        : undefined,
                    )}
                  />
                )}
              />
              {prefs.externalChromeEnabled && (
                <div className="browser-settings-external">
                  <label className="browser-settings-field">
                    <span>调试端点</span>
                    <input
                      value={prefs.externalChromeEndpoint}
                      disabled={disabled}
                      spellCheck={false}
                      placeholder="http://127.0.0.1:9222"
                      onChange={(event) => setPrefs((current) => current ? { ...current, externalChromeEndpoint: event.target.value } : current)}
                      onBlur={() => void patch({ externalChromeEndpoint: prefs.externalChromeEndpoint })}
                    />
                    <small>示例：在终端运行 <code>chrome --remote-debugging-port=9222</code>（命令因系统而异）</small>
                  </label>
                  <div className="browser-settings-external-actions">
                    <button type="button" className="settings-outline" disabled={disabled} onClick={() => void refreshExternal()}>
                      <TerminalSquare aria-hidden="true" />{busy === 'external' ? '连接中…' : '发现目标'}
                    </button>
                    <button type="button" className="settings-outline" disabled={disabled} onClick={() => void detachExternal()}>
                      断开全部
                    </button>
                  </div>
                  {externalEndpointLabel && <p className="browser-settings-help">当前端点：{externalEndpointLabel}</p>}
                  {externalWarning && <p className="browser-settings-warning">{externalWarning}</p>}
                  {externalTargets.length > 0 && (
                    <ul className="browser-settings-external-list">
                      {externalTargets.map((target) => (
                        <li key={target.id}>
                          <div>
                            <strong>{target.title || target.url || target.id}</strong>
                            <small>{target.url}</small>
                          </div>
                          <button type="button" className="settings-outline" disabled={disabled} onClick={() => void attachExternal(target.id)}>
                            <ExternalLink aria-hidden="true" />连接
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <p className="browser-settings-help">
                <Sparkles aria-hidden="true" />
                CDP 是 Chrome 的底层调试协议；外接模式不会替代内置的独立浏览配置文件。
              </p>
            </div>
          </section>
        </>
      )}

      {notice && <p className="browser-settings-message is-success" role="status">{notice}</p>}
      {error && <p className="browser-settings-message is-error" role="alert">{error}</p>}
    </div>
  );
}

function Row({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: ReactNode;
}) {
  return (
    <div className="browser-settings-row">
      <div className="browser-settings-copy">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="browser-settings-control">{control}</div>
    </div>
  );
}

function Toggle({
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
    <label className="browser-toggle">
      <span className="sr-only">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function labelForAction(value: string) {
  return ACTION_OPTIONS.find((row) => row.value === value)?.label || value;
}

function labelForDecision(value: string) {
  return DECISION_OPTIONS.find((row) => row.value === value)?.label || value;
}
