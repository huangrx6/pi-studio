import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, AppWindow, Download, ExternalLink,
  FolderOpen, History, Link2, Plus,
  TerminalSquare,
} from 'lucide-react';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { PreferenceGroup, PreferenceRow } from '../../shared/PreferenceGroup';
import { useSettingsToast } from '../../shared/SettingsToast';
import { LoadingState } from '../../shared/LoadingState';
import { useDeferredEnter } from '../../shared/useDeferredEnter';
import { Select } from '../../shared/Select';
import { SettingsDialog } from '../../shared/SettingsDialog';
import type { ModalDismiss } from '../../shared/useModalDialog';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { errorText } from '../../shared/error-text';
import { BROWSER_CLEAR_DESCRIPTION, clearBrowserProfile, type BrowserLibraryView } from './browser-history';
import { BrowserLibraryDialog } from './BrowserLibraryDialog';
import './styles/browser-settings.css';

const MANAGED_LIST_PAGE = 8;
const emptyPasswordDraft = () => ({ origin: '', username: '', password: '', note: '' });
const emptyContactDraft = () => ({ name: '', phone: '', email: '', address: '' });

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
];

const DECISION_OPTIONS = [
  { value: 'allow', label: '允许' },
  { value: 'ask', label: '需要批准' },
  { value: 'deny', label: '拒绝' },
];

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

let cachedBrowserPrefs: BrowserPreferences | null = null;
let cachedBrowserPolicies: SitePolicy[] = [];

export function BrowserSettings({ onOpenBrowser }: { onOpenBrowser?: (url?: string) => void } = {}) {
  const [prefs, setPrefs] = useState<BrowserPreferences | null>(cachedBrowserPrefs);
  const [libraryView, setLibraryView] = useState<BrowserLibraryView | null>(null);
  const [policies, setPolicies] = useState<SitePolicy[]>(cachedBrowserPolicies);
  const [busy, setBusy] = useState(cachedBrowserPrefs ? '' : 'load');
  const [policyDraft, setPolicyDraft] = useState({ originPattern: '', actionClass: 'act', decision: 'allow' });
  const [externalTargets, setExternalTargets] = useState<ExternalTarget[]>([]);
  const [externalWarning, setExternalWarning] = useState('');
  const [externalEndpointLabel, setExternalEndpointLabel] = useState('');
  const [passwords, setPasswords] = useState<PasswordRow[]>([]);
  const [passwordAvailable, setPasswordAvailable] = useState(true);
  const [passwordDraft, setPasswordDraft] = useState(emptyPasswordDraft);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordQuery, setPasswordQuery] = useState('');
  const [passwordVisibleCount, setPasswordVisibleCount] = useState(MANAGED_LIST_PAGE);
  const revealRequest = useRef(0);
  const [revealedPasswordId, setRevealedPasswordId] = useState('');
  const [revealedPasswordValue, setRevealedPasswordValue] = useState('');
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [contactDraft, setContactDraft] = useState(emptyContactDraft);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [contactQuery, setContactQuery] = useState('');
  const [contactVisibleCount, setContactVisibleCount] = useState(MANAGED_LIST_PAGE);
  const [extensions, setExtensions] = useState<ExtensionRow[]>([]);
  const [extensionsSupported, setExtensionsSupported] = useState(true);
  const generation = useRef(0);
  const confirmation = useActionConfirmation();
  const showToast = useSettingsToast();

  const load = useCallback(async () => {
    const id = ++generation.current;
    if (!cachedBrowserPrefs) setBusy('load');
    try {
      const [settings, policyResult, passwordResult, contactResult, extensionResult] = await Promise.all([
        window.piApi.browserAdvancedSettings(),
        window.piApi.browserSitePolicies(),
        window.piApi.browserPasswords().catch(() => ({ ok: false, passwords: [], available: false })),
        window.piApi.browserContacts().catch(() => ({ ok: false, contacts: [] })),
        window.piApi.browserExtensions().catch(() => ({ ok: false, extensions: [], supported: false })),
      ]);
      if (id !== generation.current) return;
      const nextPrefs = { ...emptyPrefs(), ...settings };
      const nextPolicies = Array.isArray(policyResult?.policies) ? policyResult.policies as SitePolicy[] : [];
      cachedBrowserPrefs = nextPrefs;
      cachedBrowserPolicies = nextPolicies;
      setPrefs(nextPrefs);
      setPolicies(nextPolicies);
      setPasswords(Array.isArray(passwordResult?.passwords) ? passwordResult.passwords as PasswordRow[] : []);
      setPasswordAvailable(passwordResult?.available !== false);
      setContacts(Array.isArray(contactResult?.contacts) ? contactResult.contacts as ContactRow[] : []);
      setExtensions(Array.isArray(extensionResult?.extensions) ? extensionResult.extensions as ExtensionRow[] : []);
      setExtensionsSupported(extensionResult?.supported !== false);
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }, [showToast]);

  useEffect(() => {
    if (prefs) cachedBrowserPrefs = prefs;
  }, [prefs]);
  useEffect(() => {
    cachedBrowserPolicies = policies;
  }, [policies]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const filteredPasswords = useMemo(() => {
    const q = passwordQuery.trim().toLowerCase();
    if (!q) return passwords;
    return passwords.filter((row) => (
      row.origin.toLowerCase().includes(q)
      || row.username.toLowerCase().includes(q)
      || String(row.note || '').toLowerCase().includes(q)
    ));
  }, [passwords, passwordQuery]);

  const visiblePasswords = useMemo(
    () => filteredPasswords.slice(0, passwordVisibleCount),
    [filteredPasswords, passwordVisibleCount],
  );

  const filteredContacts = useMemo(() => {
    const q = contactQuery.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((row) => (
      row.name.toLowerCase().includes(q)
      || String(row.phone || '').toLowerCase().includes(q)
      || String(row.email || '').toLowerCase().includes(q)
      || String(row.address || '').toLowerCase().includes(q)
    ));
  }, [contacts, contactQuery]);

  const visibleContacts = useMemo(
    () => filteredContacts.slice(0, contactVisibleCount),
    [filteredContacts, contactVisibleCount],
  );

  useEffect(() => {
    setPasswordVisibleCount((count) => {
      if (filteredPasswords.length === 0) return MANAGED_LIST_PAGE;
      return Math.min(Math.max(count, MANAGED_LIST_PAGE), filteredPasswords.length);
    });
  }, [filteredPasswords.length]);

  useEffect(() => {
    setContactVisibleCount((count) => {
      if (filteredContacts.length === 0) return MANAGED_LIST_PAGE;
      return Math.min(Math.max(count, MANAGED_LIST_PAGE), filteredContacts.length);
    });
  }, [filteredContacts.length]);

  function passwordDraftDirty() {
    return Boolean(
      passwordDraft.origin.trim()
      || passwordDraft.username.trim()
      || passwordDraft.password
      || passwordDraft.note.trim(),
    );
  }

  function contactDraftDirty() {
    return Boolean(
      contactDraft.name.trim()
      || contactDraft.phone.trim()
      || contactDraft.email.trim()
      || contactDraft.address.trim(),
    );
  }

  async function openPasswordDialog() {
    setPasswordDraft(emptyPasswordDraft());
    setPasswordDialogOpen(true);
  }

  async function closePasswordDialog(dismiss?: ModalDismiss) {
    if (busy === 'password') return;
    if (passwordDraftDirty()) {
      const accepted = await confirmation.confirm({
        title: '丢弃未保存的密码？',
        description: '关闭后将清空当前填写的内容，不会写入本机。',
        confirmLabel: '丢弃并关闭',
        tone: 'danger',
      });
      if (!accepted) return;
    }
    const close = () => {
      setPasswordDialogOpen(false);
      setPasswordDraft(emptyPasswordDraft());
    };
    if (dismiss) await dismiss(close); else close();
  }

  async function openContactDialog() {
    setContactDraft(emptyContactDraft());
    setContactDialogOpen(true);
  }

  async function closeContactDialog(dismiss?: ModalDismiss) {
    if (busy === 'contact') return;
    if (contactDraftDirty()) {
      const accepted = await confirmation.confirm({
        title: '丢弃未保存的联系人？',
        description: '关闭后将清空当前填写的内容，不会写入本机。',
        confirmLabel: '丢弃并关闭',
        tone: 'danger',
      });
      if (!accepted) return;
    }
    const close = () => {
      setContactDialogOpen(false);
      setContactDraft(emptyContactDraft());
    };
    if (dismiss) await dismiss(close); else close();
  }

  async function patch(
    partial: Partial<BrowserPreferences>,
    confirmOptions?: { title: string; description?: string; confirmLabel?: string; tone?: 'default' | 'danger' },
  ) {
    if (!prefs || busy) return;
    if (confirmOptions) {
      const accepted = await confirmation.confirm({
        title: confirmOptions.title,
        description: confirmOptions.description,
        confirmLabel: confirmOptions.confirmLabel || '开启',
        tone: confirmOptions.tone || 'default',
      });
      if (!accepted) return;
    }
    const id = ++generation.current;
    setBusy('save');
    try {
      const result = await window.piApi.browserSetPreferences(partial);
      if (id !== generation.current) return;
      const next = { ...emptyPrefs(), ...(result.preferences || result) };
      setPrefs(next);
      showToast('已保存');
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function clearData() {
    const accepted = await confirmation.confirm({
      title: '清除浏览数据？',
      description: BROWSER_CLEAR_DESCRIPTION,
      confirmLabel: '清除数据',
      tone: 'danger',
    });
    if (!accepted) return;
    const id = ++generation.current;
    setBusy('clear');
    try {
      await clearBrowserProfile();
      if (id === generation.current) showToast('已清除浏览数据');
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function pickDownloadDir() {
    const id = ++generation.current;
    setBusy('folder');
    try {
      const result = await window.piApi.browserPickDownloadDirectory();
      if (id !== generation.current) return;
      if (result.ok && result.preferences) {
        setPrefs({ ...emptyPrefs(), ...result.preferences });
        showToast(`下载目录：${result.path}`);
      }
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function addPolicy() {
    const originPattern = policyDraft.originPattern.trim();
    if (!originPattern) {
      showToast('请填写网站或模式，例如 example.com 或 *.example.com', 'error');
      return;
    }
    const id = ++generation.current;
    setBusy('policy');
    try {
      const result = await window.piApi.browserSitePolicyUpsert({
        originPattern,
        actionClass: policyDraft.actionClass,
        decision: policyDraft.decision,
      });
      if (id !== generation.current) return;
      setPolicies(Array.isArray(result.policies) ? result.policies as SitePolicy[] : []);
      setPolicyDraft((current) => ({ ...current, originPattern: '' }));
      showToast('已更新网站权限');
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function removePolicy(row: SitePolicy) {
    const accepted = await confirmation.confirm({
      title: '删除网站权限？',
      description: `将移除「${row.originPattern}」的自定义权限规则。`,
      confirmLabel: '删除规则',
      tone: 'danger',
    });
    if (!accepted) return;
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
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function refreshExternal() {
    const id = ++generation.current;
    setBusy('external');
    setExternalWarning('');
    try {
      const result = await window.piApi.browserExternalTargets();
      if (id !== generation.current) return;
      setExternalTargets(Array.isArray(result.targets) ? result.targets : []);
      setExternalEndpointLabel(result.endpoint || '');
      setExternalWarning(result.warning || '');
      showToast(result.ok ? `已发现 ${result.targets?.length || 0} 个页面目标` : '未连接');
    } catch (cause) {
      if (id === generation.current) {
        setExternalTargets([]);
        showToast(errorText(cause), 'error');
      }
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function attachExternal(targetId: string) {
    const id = ++generation.current;
    setBusy('external');
    try {
      const result = await window.piApi.browserExternalAttach({ targetId });
      if (id !== generation.current) return;
      showToast(result.ok ? '已连接到外部 Chrome 标签' : '连接失败');
      if (result.warning) setExternalWarning(String(result.warning));
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function detachExternal() {
    const id = ++generation.current;
    setBusy('external');
    try {
      await window.piApi.browserExternalDetach({});
      if (id === generation.current) showToast('已断开全部外接会话');
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function savePassword(dismiss: ModalDismiss) {
    const origin = passwordDraft.origin.trim();
    const username = passwordDraft.username.trim();
    if (!origin || !username || !passwordDraft.password) {
      showToast('请填写网站、用户名和密码', 'error');
      return;
    }
    const id = ++generation.current;
    setBusy('password');
    try {
      const result = await window.piApi.browserPasswordUpsert({
        origin,
        username,
        password: passwordDraft.password,
        note: passwordDraft.note,
      });
      if (id !== generation.current) return;
      setPasswords(Array.isArray(result.passwords) ? result.passwords as PasswordRow[] : []);
      setPasswordDraft(emptyPasswordDraft());
      setPasswordVisibleCount(MANAGED_LIST_PAGE);
      setRevealedPasswordId('');
      setRevealedPasswordValue('');
      await dismiss(() => {
        setPasswordDialogOpen(false);
        showToast('已保存密码');
      });
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function removePassword(row: PasswordRow) {
    const accepted = await confirmation.confirm({
      title: '删除保存的密码？',
      description: `将删除 ${row.origin} 上账号 ${row.username} 的本机保存密码，此操作不可恢复。`,
      confirmLabel: '删除密码',
      tone: 'danger',
    });
    if (!accepted) return;
    const id = ++generation.current;
    setBusy('password');
    try {
      const result = await window.piApi.browserPasswordRemove({ id: row.id });
      if (id !== generation.current) return;
      setPasswords(Array.isArray(result.passwords) ? result.passwords as PasswordRow[] : []);
      if (revealedPasswordId === row.id) {
        setRevealedPasswordId('');
        setRevealedPasswordValue('');
      }
      showToast('已删除密码');
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  function hideRevealedPassword() {
    revealRequest.current++;
    setRevealedPasswordId('');
    setRevealedPasswordValue('');
  }

  async function toggleRevealPassword(row: PasswordRow) {
    if (revealedPasswordId === row.id) {
      hideRevealedPassword();
      return;
    }
    const id = ++generation.current;
    setBusy('password');
    try {
      const request = ++revealRequest.current;
      const result = await window.piApi.browserPasswordReveal({ id: row.id });
      if (id !== generation.current || request !== revealRequest.current) return;
      setRevealedPasswordId(row.id);
      setRevealedPasswordValue(result.password?.password || '');
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function copyRevealedPassword() {
    if (!revealedPasswordValue) return;
    try {
      await navigator.clipboard.writeText(revealedPasswordValue);
      showToast('密码已复制到剪贴板');
    } catch (cause) {
      showToast(errorText(cause), 'error');
    }
  }

  async function saveContact(dismiss: ModalDismiss) {
    const name = contactDraft.name.trim();
    if (!name) {
      showToast('请填写联系人姓名', 'error');
      return;
    }
    const id = ++generation.current;
    setBusy('contact');
    try {
      const result = await window.piApi.browserContactUpsert({ ...contactDraft, name });
      if (id !== generation.current) return;
      setContacts(Array.isArray(result.contacts) ? result.contacts as ContactRow[] : []);
      setContactVisibleCount(MANAGED_LIST_PAGE);
      await dismiss(() => {
        setContactDraft(emptyContactDraft());
        setContactDialogOpen(false);
        showToast('已保存联系信息');
      });
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function removeContact(row: ContactRow) {
    const accepted = await confirmation.confirm({
      title: '删除联系人？',
      description: `将删除联系人「${row.name}」，此操作不可恢复。`,
      confirmLabel: '删除联系人',
      tone: 'danger',
    });
    if (!accepted) return;
    const id = ++generation.current;
    setBusy('contact');
    try {
      const result = await window.piApi.browserContactRemove({ id: row.id });
      if (id !== generation.current) return;
      setContacts(Array.isArray(result.contacts) ? result.contacts as ContactRow[] : []);
      showToast('已删除联系人');
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function loadExtension() {
    const id = ++generation.current;
    setBusy('extension');
    try {
      const result = await window.piApi.browserExtensionLoad({});
      if (id !== generation.current) return;
      if (result.cancelled) return;
      setExtensions(Array.isArray(result.extensions) ? result.extensions as ExtensionRow[] : []);
      showToast(result.ok ? '已加载扩展' : '未能加载扩展');
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  async function removeExtension(row: ExtensionRow) {
    const accepted = await confirmation.confirm({
      title: '移除浏览器扩展？',
      description: `将移除扩展「${row.name}」。`,
      confirmLabel: '移除扩展',
      tone: 'danger',
    });
    if (!accepted) return;
    const id = ++generation.current;
    setBusy('extension');
    try {
      const result = await window.piApi.browserExtensionRemove({ id: row.id, path: row.path });
      if (id !== generation.current) return;
      setExtensions(Array.isArray(result.extensions) ? result.extensions as ExtensionRow[] : []);
      showToast('已移除扩展');
    } catch (cause) {
      if (id === generation.current) showToast(errorText(cause), 'error');
    } finally {
      if (id === generation.current) setBusy('');
    }
  }

  const disabled = Boolean(busy);
  const groupsReveal = useDeferredEnter(Boolean(prefs));

  return (
    <div className="settings-preference-page browser-settings">
      <SettingsPageHeader title="浏览器" iconPosition="end" meta="工作台浏览器行为、数据与站点策略。"
        icon={<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="26" height="22" rx="3.5" /><path d="M3 12h26" />
          <path d="M8 8.5h5" stroke="var(--accent)" />
        </svg>} />

      {!prefs && busy && <div className="settings-loading-card"><LoadingState variant="section">正在读取浏览器设置…</LoadingState></div>}
      {!prefs && !busy && (
        <div className="settings-load-error">
          <p role="alert">无法读取浏览器设置，请重试。</p>
          <button type="button" className="settings-outline" onClick={() => void load()}>重新加载</button>
        </div>
      )}

      {prefs && (
        <div className={`settings-preference-groups${groupsReveal ? ' settings-async-ready' : ''}`}>
          <div className="settings-preference-card browser-command-bar" role="region" aria-label="快捷操作">
            <div className="browser-command-lead">
              <span className={`browser-live-dot${prefs.agentControlEnabled ? ' is-on' : ''}`} aria-hidden="true" />
              <strong>工作台浏览器</strong>
              <span>{prefs.agentControlEnabled ? '智能体可操控' : '仅手动浏览'}</span>
            </div>
            <div className="browser-command-actions">
              <button type="button" className="browser-ghost-btn" aria-label="管理浏览历史" aria-haspopup="dialog" onClick={() => setLibraryView('history')}>
                <History aria-hidden="true" />历史
              </button>
              <button type="button" className="browser-ghost-btn" aria-label="管理下载历史" aria-haspopup="dialog" onClick={() => setLibraryView('downloads')}>
                <Download aria-hidden="true" />下载
              </button>
              <button type="button" className="browser-ghost-btn is-danger" disabled={disabled} onClick={() => void clearData()}>
                {busy === 'clear' ? '清除中…' : '清除数据'}
              </button>
              {onOpenBrowser && <button type="button" className="settings-save" onClick={() => onOpenBrowser()}>
                <AppWindow aria-hidden="true" />打开浏览器
              </button>}
            </div>
          </div>

          <PreferenceGroup title="常规">
            <PreferenceRow
              title="允许智能体控制浏览器"
              control={(
                <Toggle
                  checked={prefs.agentControlEnabled}
                  disabled={disabled}
                  label="允许智能体控制浏览器"
                  onChange={(checked) => void patch({ agentControlEnabled: checked })}
                />
              )}
            />
            <div className="browser-link-grid">
              <div className="browser-link-tile">
                <h3>网页链接打开位置</h3>
                <Select
                  value={prefs.webLinkOpenTarget}
                  disabled={disabled}
                  label="网页链接打开位置"
                  options={[
                    { value: 'workbench', label: '工作台浏览器' },
                    { value: 'system', label: '系统浏览器' },
                  ]}
                  onChange={(value) => void patch({ webLinkOpenTarget: value })}
                />
              </div>
              <div className="browser-link-tile">
                <h3>本地链接打开位置</h3>
                <Select
                  value={prefs.localLinkOpenTarget}
                  disabled={disabled}
                  label="本地链接打开位置"
                  options={[
                    { value: 'workbench', label: '工作台浏览器' },
                    { value: 'system', label: '系统浏览器' },
                  ]}
                  onChange={(value) => void patch({ localLinkOpenTarget: value })}
                />
              </div>
            </div>
            <PreferenceRow
              title="地址栏显示完整网址"
              control={(
                <Toggle
                  checked={prefs.showFullUrl}
                  disabled={disabled}
                  label="显示完整网址"
                  onChange={(checked) => void patch({ showFullUrl: checked })}
                />
              )}
            />
          </PreferenceGroup>

          <PreferenceGroup title="下载">
            <div className="browser-download-path-field">
              <h3>默认保存位置</h3>
              <div className="browser-download-path-row">
                <code title={prefs.downloadDirectory || prefs.defaultDownloadDirectory || ''}>
                  {prefs.downloadDirectory || prefs.defaultDownloadDirectory || 'Studio 托管的下载目录'}
                </code>
                <button type="button" className="settings-outline" disabled={disabled} onClick={() => void pickDownloadDir()}>
                  <Download aria-hidden="true" />更改
                </button>
              </div>
            </div>
            <PreferenceRow
              title="下载前询问保存位置"
              control={(
                <Toggle
                  checked={prefs.askDownloadPath}
                  disabled={disabled}
                  label="下载前询问保存位置"
                  onChange={(checked) => void patch({ askDownloadPath: checked })}
                />
              )}
            />
          </PreferenceGroup>

          <div className="settings-preference-card">
            <PreferenceGroup grouped title="自动填充与密码" onCollapse={hideRevealedPassword} summary={passwordAvailable ? `${passwords.length} 项` : '不可用'}>
              <div className="browser-settings-manage-block">
                <div className="browser-settings-manage-head">
                  <p>{passwordAvailable ? '本机安全存储' : '当前环境不支持安全存储'}</p>
                  <button type="button" className="settings-outline" disabled={disabled || !passwordAvailable} onClick={() => void openPasswordDialog()}>
                    <Plus aria-hidden="true" />添加
                  </button>
                </div>
                {passwords.length > 0 && (
                  <div className="browser-settings-list-toolbar">
                    <input
                      className="browser-settings-list-search"
                      value={passwordQuery}
                      disabled={disabled}
                      placeholder="搜索网站、用户名或备注"
                      aria-label="搜索保存的密码"
                      onChange={(event) => {
                        setPasswordQuery(event.target.value);
                        setPasswordVisibleCount(MANAGED_LIST_PAGE);
                      }}
                    />
                    <span className="browser-settings-list-count">{filteredPasswords.length} / {passwords.length}</span>
                  </div>
                )}
                {passwords.length === 0 ? (
                  <p className="browser-settings-empty">还没有保存的密码。点击右上角「添加」。</p>
                ) : filteredPasswords.length === 0 ? (
                  <p className="browser-settings-empty">没有匹配「{passwordQuery.trim()}」的密码</p>
                ) : (
                  <>
                    <ul className="browser-settings-manage-list">
                      {visiblePasswords.map((row) => (
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
                    <div className="browser-settings-list-footer">
                      <span role="status">已显示 {visiblePasswords.length} / {filteredPasswords.length}</span>
                      {visiblePasswords.length < filteredPasswords.length && (
                        <button type="button" className="settings-text-button" disabled={disabled} onClick={() => setPasswordVisibleCount((count) => count + MANAGED_LIST_PAGE)}>
                          加载更多
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </PreferenceGroup>

            <PreferenceGroup grouped title="联系信息" summary={`${contacts.length} 项`}>
              <div className="browser-settings-manage-block">
                <div className="browser-settings-manage-head">
                  <p>本机存储</p>
                  <button type="button" className="settings-outline" disabled={disabled} onClick={() => void openContactDialog()}>
                    <Plus aria-hidden="true" />添加
                  </button>
                </div>
                {contacts.length > 0 && (
                  <div className="browser-settings-list-toolbar">
                    <input
                      className="browser-settings-list-search"
                      value={contactQuery}
                      disabled={disabled}
                      placeholder="搜索姓名、电话、邮箱或地址"
                      aria-label="搜索联系人"
                      onChange={(event) => {
                        setContactQuery(event.target.value);
                        setContactVisibleCount(MANAGED_LIST_PAGE);
                      }}
                    />
                    <span className="browser-settings-list-count">{filteredContacts.length} / {contacts.length}</span>
                  </div>
                )}
                {contacts.length === 0 ? (
                  <p className="browser-settings-empty">还没有联系信息。点击右上角「添加」。</p>
                ) : filteredContacts.length === 0 ? (
                  <p className="browser-settings-empty">没有匹配「{contactQuery.trim()}」的联系人</p>
                ) : (
                  <>
                    <ul className="browser-settings-manage-list">
                      {visibleContacts.map((row) => (
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
                    <div className="browser-settings-list-footer">
                      <span role="status">已显示 {visibleContacts.length} / {filteredContacts.length}</span>
                      {visibleContacts.length < filteredContacts.length && (
                        <button type="button" className="settings-text-button" disabled={disabled} onClick={() => setContactVisibleCount((count) => count + MANAGED_LIST_PAGE)}>
                          加载更多
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </PreferenceGroup>

            <PreferenceGroup grouped title="扩展程序" summary={extensionsSupported ? `${extensions.length} 项` : '不可用'}>
              <div className="browser-settings-manage-block">
                <div className="browser-settings-manage-head">
                  <p>{extensionsSupported ? '仅支持本地解压目录（manifest.json）' : '当前平台不支持'}</p>
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
            </PreferenceGroup>
          </div>

          <PreferenceGroup title="浏览器权限" description={policies.length ? `${policies.length} 条站点例外` : undefined}>
            <div className="browser-link-grid browser-permission-grid">
              <div className="browser-link-tile">
                <h3>历史记录访问</h3>
                <Select
                  value={prefs.historyAccess}
                  disabled={disabled}
                  label="历史记录访问"
                  options={[
                    { value: 'ask', label: '始终询问' },
                    { value: 'allow', label: '始终允许' },
                    { value: 'deny', label: '拒绝' },
                  ]}
                  onChange={(value) => void patch({ historyAccess: value })}
                />
              </div>
              <div className="browser-link-tile">
                <h3>批注截图</h3>
                <Select
                  value={prefs.annotatedScreenshots}
                  disabled={disabled}
                  label="批注截图"
                  options={[
                    { value: 'always', label: '始终包含' },
                    { value: 'never', label: '关闭' },
                  ]}
                  onChange={(value) => void patch({ annotatedScreenshots: value })}
                />
              </div>
            </div>
            <div className="browser-settings-policy-block">
                <div className="browser-settings-policy-head">
                  <h3>网站例外</h3>
                </div>
                <form className="browser-settings-policy-form" onSubmit={event => {
                  event.preventDefault();
                  if (!disabled) void addPolicy();
                }}>
                  <label><span>网站或模式</span>
                    <input
                      required value={policyDraft.originPattern} disabled={disabled}
                      placeholder="example.com 或 *.example.com" spellCheck={false}
                      onChange={event => setPolicyDraft(current => ({ ...current, originPattern: event.target.value }))}
                    />
                  </label>
                  <div><span>动作类型</span>
                    <Select value={policyDraft.actionClass} disabled={disabled} label="动作类型" options={ACTION_OPTIONS}
                      onChange={value => setPolicyDraft(current => ({ ...current, actionClass: value }))} />
                  </div>
                  <div><span>决策</span>
                    <Select value={policyDraft.decision} disabled={disabled} label="决策" options={DECISION_OPTIONS}
                      onChange={value => setPolicyDraft(current => ({ ...current, decision: value }))} />
                  </div>
                  <button type="submit" className="settings-outline" disabled={disabled}>
                    <Link2 aria-hidden="true" />添加
                  </button>
                </form>
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
          </PreferenceGroup>

          <PreferenceGroup title="开发者模式" summary={prefs.evaluateEnabled || prefs.cdpEnabled || prefs.externalChromeEnabled ? '已开启' : '已关闭'}>
              <div className="browser-settings-risk" role="status">
                <AlertTriangle aria-hidden="true" />
                <span>高风险调试能力，默认关闭；开启后仍按站点授权。</span>
              </div>
              <PreferenceRow
                title="页面脚本求值"
                description="browser_evaluate"
                control={(
                  <Toggle
                    checked={prefs.evaluateEnabled}
                    disabled={disabled}
                    label="页面脚本求值"
                    onChange={(checked) => void patch(
                      { evaluateEnabled: checked },
                      checked ? {
                        title: '开启页面脚本求值？',
                        description: '开启后，智能体可在你授权的站点上执行页面脚本（browser_evaluate）。',
                        confirmLabel: '开启',
                        tone: 'danger',
                      } : undefined,
                    )}
                  />
                )}
              />
              <PreferenceRow
                title="完整 CDP 访问"
                description="Chrome DevTools Protocol"
                control={(
                  <Toggle
                    checked={prefs.cdpEnabled}
                    disabled={disabled}
                    label="完整 CDP"
                    onChange={(checked) => void patch(
                      { cdpEnabled: checked, ...(checked ? {} : { externalChromeEnabled: false }) },
                      checked ? {
                        title: '启用完整 CDP 访问？',
                        description: '开启后，智能体可检查并控制更底层的浏览器功能，可能使你的数据面临风险。请仅在理解风险时开启。',
                        confirmLabel: '启用 CDP',
                        tone: 'danger',
                      } : undefined,
                    )}
                  />
                )}
              />
              <PreferenceRow
                title="外接本机 Chrome"
                description="需同时开启完整 CDP"
                control={(
                  <Toggle
                    checked={prefs.externalChromeEnabled}
                    disabled={disabled || !prefs.cdpEnabled}
                    label="外接 Chrome"
                    onChange={(checked) => void patch(
                      { externalChromeEnabled: checked },
                      checked ? {
                        title: '外接本机 Chrome？',
                        description: '外接 Chrome 可触及该调试实例中的已登录会话。请确认调试端口仅本机可用，且你信任当前环境。',
                        confirmLabel: '开启外接',
                        tone: 'danger',
                      } : undefined,
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
          </PreferenceGroup>
        </div>
      )}

      {passwordDialogOpen && (
        <SettingsDialog
          title="添加保存的密码"
          action="保存密码"
          busyAction="正在保存…"
          busy={busy === 'password'}
          loading={false}
          error={null}
          onClose={() => void closePasswordDialog()}
          onRequestClose={dismiss => void closePasswordDialog(dismiss)}
          onSubmit={dismiss => void savePassword(dismiss)}
        >
          <div className="settings-form-grid browser-settings-dialog-form">
            <label>
              <span>网站</span>
              <input
                required
                value={passwordDraft.origin}
                placeholder="例如 example.com"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setPasswordDraft((current) => ({ ...current, origin: event.target.value }))}
              />
            </label>
            <label>
              <span>用户名</span>
              <input
                required
                value={passwordDraft.username}
                placeholder="登录名或邮箱"
                autoComplete="username"
                onChange={(event) => setPasswordDraft((current) => ({ ...current, username: event.target.value }))}
              />
            </label>
            <label>
              <span>密码</span>
              <input
                type="password"
                required
                value={passwordDraft.password}
                placeholder="密码"
                autoComplete="new-password"
                onChange={(event) => setPasswordDraft((current) => ({ ...current, password: event.target.value }))}
              />
            </label>
            <label>
              <span>备注（可选）</span>
              <input
                value={passwordDraft.note}
                placeholder="例如工作账号"
                onChange={(event) => setPasswordDraft((current) => ({ ...current, note: event.target.value }))}
              />
            </label>
          </div>
        </SettingsDialog>
      )}

      {contactDialogOpen && (
        <SettingsDialog
          title="添加联系人"
          action="保存联系人"
          busyAction="正在保存…"
          busy={busy === 'contact'}
          loading={false}
          error={null}
          onClose={() => void closeContactDialog()}
          onRequestClose={dismiss => void closeContactDialog(dismiss)}
          onSubmit={dismiss => void saveContact(dismiss)}
        >
          <div className="settings-form-grid browser-settings-dialog-form">
            <label>
              <span>姓名</span>
              <input
                required
                value={contactDraft.name}
                placeholder="姓名"
                autoComplete="name"
                onChange={(event) => setContactDraft((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label>
              <span>电话</span>
              <input
                type="tel"
                value={contactDraft.phone}
                placeholder="电话"
                autoComplete="tel"
                onChange={(event) => setContactDraft((current) => ({ ...current, phone: event.target.value }))}
              />
            </label>
            <label>
              <span>邮箱</span>
              <input
                value={contactDraft.email}
                placeholder="邮箱"
                autoComplete="email"
                onChange={(event) => setContactDraft((current) => ({ ...current, email: event.target.value }))}
              />
            </label>
            <label>
              <span>地址</span>
              <input
                value={contactDraft.address}
                placeholder="地址"
                autoComplete="street-address"
                onChange={(event) => setContactDraft((current) => ({ ...current, address: event.target.value }))}
              />
            </label>
          </div>
        </SettingsDialog>
      )}

      {libraryView && (
        <BrowserLibraryDialog
          view={libraryView}
          onClose={() => setLibraryView(null)}
          onOpenUrl={onOpenBrowser}
        />
      )}

      {confirmation.dialog}
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

function labelForAction(value: string) {
  return ACTION_OPTIONS.find((row) => row.value === value)?.label || value;
}

function labelForDecision(value: string) {
  return DECISION_OPTIONS.find((row) => row.value === value)?.label || value;
}
