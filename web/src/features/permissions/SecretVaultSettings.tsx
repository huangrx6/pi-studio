import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { useEffect, useRef, useState } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { errorText } from '../../shared/error-text';
import { PreferenceGroup } from '../../shared/PreferenceGroup';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { useSettingsToast } from '../../shared/SettingsToast';
import './styles/secret-vault.css';

type SecretName = { name: string; updatedAt: number };

/**
 * The renderer only receives secret names and update timestamps. Secret values
 * stay behind the main-process safeStorage boundary and are referenced in
 * prompts through the `{{secret:NAME}}` placeholder.
 */
export function SecretVaultSettings() {
  const showToast = useSettingsToast();
  const confirmation = useActionConfirmation();
  const [items, setItems] = useState<SecretName[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const replacing = items.some((item) => item.name === name.trim().toUpperCase());
  const copyRequest = useRef(0);

  useSettingsDraftGuard({ label: '凭据输入', dirty: Boolean(name || value) });

  async function load() {
    setLoading(true);
    try {
      const next = await window.piApi.listSecrets();
      setItems(Array.isArray(next) ? next : []);
      setLoadError('');
    } catch (cause) {
      setLoadError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => () => { copyRequest.current += 1; }, []);

  async function copyReference(name: string) {
    const request = ++copyRequest.current;
    try {
      await navigator.clipboard.writeText(`{{secret:${name}}}`);
      if (request === copyRequest.current) showToast(`已复制 ${name} 的引用。`);
    } catch (cause) {
      if (request === copyRequest.current) showToast(errorText(cause), 'error');
    }
  }

  async function save() {
    const normalizedName = name.trim().toUpperCase();
    if (busy || loading || loadError || !normalizedName || !value) return;
    setBusy(true);
    try {
      const saved = await window.piApi.setSecret({ name: normalizedName, value });
      setItems(current => [...current.filter(item => item.name !== saved.name), saved].sort((left, right) => {
        if (left.name === right.name) return 0;
        return left.name < right.name ? -1 : 1;
      }));
      setName('');
      setValue('');
      showToast(`凭据 ${normalizedName} 已加密保存。`);
    } catch (cause) {
      showToast(errorText(cause), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: SecretName) {
    const accepted = await confirmation.confirm({
      title: `删除凭据 ${item.name}？`,
      description: '使用这个占位符的工具调用会立即变为不可用，已提交的历史消息不会改变。',
      confirmLabel: '删除凭据',
      tone: 'danger',
    });
    if (!accepted || busy) return;
    setBusy(true);
    try {
      await window.piApi.removeSecret(item.name);
      setItems(current => current.filter(entry => entry.name !== item.name));
      showToast(`凭据 ${item.name} 已删除。`);
    } catch (cause) {
      showToast(errorText(cause), 'error');
    } finally {
      setBusy(false);
    }
  }

  return <div className="settings-preference-page secret-vault-page">
    <SettingsPageHeader title="测试凭据" iconPosition="end" meta="本机加密保存，对话中通过 {{secret:NAME}} 引用。"
      icon={<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19.5 4.5a8 8 0 0 0-7.5 11L4 23.5V28h4.5l2.5-2.5v-3h3l3.5-3.5a8 8 0 1 0 2-14.5z" />
        <circle cx="22" cy="10.5" r="1.75" />
      </svg>} />
    <div className="settings-preference-groups">
      <PreferenceGroup title="添加或更新凭据">
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <fieldset className="secret-vault-form" disabled={busy || loading || Boolean(loadError)}>
            <label>
              <span>名称</span>
              <input
                value={name}
                aria-describedby="secret-name-hint"
                maxLength={64}
                pattern="[A-Z][A-Z0-9_]{0,63}"
                title="以英文字母开头，可包含大写字母、数字和下划线"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="TEST_TOKEN"
                onChange={(event) => setName(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
              />
            </label>
            <label>
              <span>值</span>
              <input
                type="password"
                value={value}
                maxLength={65_536}
                autoComplete="new-password"
                placeholder={replacing ? '输入新的凭据值' : '输入凭据值'}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
            <div className="secret-vault-submit">
              <div className="secret-vault-submit-copy">
                <span className="secret-vault-hint" id="secret-name-hint">{replacing ? '保存后将替换同名凭据' : '大写字母开头，支持数字与下划线'}</span>
                {name.trim() && <code className="secret-vault-preview">{`{{secret:${name.trim().toUpperCase()}}}`}</code>}
              </div>
              <button type="submit" className="settings-save" disabled={busy || !name.trim() || !value}>
                {busy && <LoadingIndicator />}{replacing ? '更新凭据' : '保存凭据'}
              </button>
            </div>
          </fieldset>
        </form>
      </PreferenceGroup>
      <PreferenceGroup title="已保存的凭据"
        actions={!loading && !loadError && items.length > 0 && <span className="secret-vault-count">{items.length} 项</span>}>
        {loading ? <LoadingState variant="section">正在读取凭据…</LoadingState>
          : loadError ? <div className="secret-vault-load-error"><p role="alert">{loadError}</p>
            <button type="button" className="settings-outline" onClick={() => void load()}>重新读取凭据</button></div>
          : items.length > 0
          ? <div className="secret-vault-list" aria-label="已保存的测试凭据">
            {items.map((item) => <div key={item.name} className="secret-vault-row">
              <span className="secret-vault-ref"><strong>{item.name}</strong><code>{`{{secret:${item.name}}}`}</code></span>
              <small title="更新日期">{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</small>
              <button type="button" className="icon-button" aria-label={`复制凭据引用 ${item.name}`} title="复制引用"
                onClick={() => void copyReference(item.name)}><Copy /></button>
              <button
                type="button"
                className="icon-button resource-delete"
                aria-label={`删除凭据 ${item.name}`}
                title="删除凭据"
                disabled={busy}
                onClick={() => void remove(item)}
              ><Trash2 /></button>
            </div>)}
          </div>
          : <p className="secret-vault-empty">还没有保存测试凭据。</p>}
      </PreferenceGroup>
    </div>
    {confirmation.dialog}
  </div>;
}
