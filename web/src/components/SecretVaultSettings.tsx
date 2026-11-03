import { useEffect, useState } from 'react';
import { Copy, KeyRound, LoaderCircle, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useActionConfirmation } from './ConfirmDialog';
import { errorText } from '../lib/error-text';
import '../styles/secret-vault.css';

type SecretName = { name: string; updatedAt: number };

export function SecretVaultSettings() {
  const confirmation = useActionConfirmation();
  const [items, setItems] = useState<SecretName[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const replacing = items.some((item) => item.name === name.trim().toUpperCase());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    try {
      const next = await window.piApi.listSecrets();
      setItems(Array.isArray(next) ? next : []);
      setError('');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function save() {
    const normalizedName = name.trim().toUpperCase();
    if (busy || loading || !normalizedName || !value) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await window.piApi.setSecret({ name: normalizedName, value });
      setName('');
      setValue('');
      setNotice(`凭据 ${normalizedName} 已加密保存。`);
      await load();
    } catch (cause) {
      setError(errorText(cause));
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
    setError('');
    setNotice('');
    try {
      await window.piApi.removeSecret(item.name);
      setNotice(`凭据 ${item.name} 已删除。`);
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <section className="settings-card secret-vault-card">
      <div className="settings-card-head">
        <div>
          <h2>测试凭据</h2>
          <p>在消息中使用 <code>{'{{secret:NAME}}'}</code> 引用凭据，无需粘贴明文。已保存的值不会显示。</p>
        </div>
        <span className="resource-status is-on"><ShieldCheck />加密保存</span>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset className="secret-vault-form" disabled={busy || loading}>
        <label>
          <span>名称</span>
          <input
            value={name}
            maxLength={64}
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
        <button type="submit" className="settings-add-button" disabled={busy || !name.trim() || !value}>
          {busy ? <LoaderCircle className="spin" /> : <Plus />}{busy ? '正在保存…' : replacing ? '更新凭据' : '保存凭据'}
        </button>
        </fieldset>
      </form>
      {replacing && <p className="secret-vault-hint">保存后将替换同名凭据，已有引用会使用新值。</p>}
      {loading ? <div className="settings-loading" role="status"><LoaderCircle className="spin" />正在读取凭据…</div> : items.length > 0
        ? <div className="secret-vault-list" aria-label="已保存的测试凭据">
          {items.map((item) => <div key={item.name} className="secret-vault-row">
            <span className="secret-vault-icon"><KeyRound /></span>
            <span><strong>{item.name}</strong><code>{`{{secret:${item.name}}}`}</code></span>
            <small title="更新日期">{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</small>
            <button type="button" className="icon-button" aria-label={`复制凭据引用 ${item.name}`} title="复制引用" onClick={() => {
              void navigator.clipboard.writeText(`{{secret:${item.name}}}`).then(() => {
                setError('');
                setNotice(`已复制 ${item.name} 的引用。`);
              }).catch((cause) => setError(errorText(cause)));
            }}><Copy /></button>
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
        : <div className="settings-empty settings-empty--small">还没有保存测试凭据。</div>}
      {error && <p className="permission-policy-message is-error" role="alert">{error}</p>}
      {notice && <p className="permission-policy-message is-success" role="status">{notice}</p>}
    </section>
    {confirmation.dialog}
  </>;
}
