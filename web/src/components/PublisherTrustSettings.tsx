import { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, ShieldX } from 'lucide-react';
import type {
  ExtensionPublisherTrustKey,
  ExtensionPublisherTrustSnapshot,
} from '../types/extension-types';
import { SettingsDialog } from './SettingsDialog';
import { SettingsResourceCard } from './SettingsResourceCard';

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function dateText(timestamp: number | undefined) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString();
}

export function PublisherTrustSettings() {
  const [snapshot, setSnapshot] = useState<ExtensionPublisherTrustSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{
    publisher: string;
    key: ExtensionPublisherTrustKey;
  } | null>(null);

  useEffect(() => {
    let active = true;
    void window.piApi.extensionPublisherTrust()
      .then((value) => {
        if (active) setSnapshot(value);
      })
      .catch((reason) => {
        if (active) setError(errorText(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  async function revoke() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.piApi.revokeExtensionPublisherKey({
        publisher: pending.publisher,
        keyId: pending.key.keyId,
      });
      setSnapshot(next);
      setPending(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  const publishers = (snapshot?.publishers || []).filter((item) => item.keys.length > 0);
  if (!snapshot || publishers.length === 0) return null;

  return <>
    <section className="settings-card publisher-trust-settings">
      <div className="settings-card-head publisher-trust-head">
        <div className="publisher-trust-heading-copy">
          <span><KeyRound /></span>
          <div>
            <h2>发布者公钥</h2>
            <p>Ed25519 公钥用于确认签名者身份。撤销不可恢复；之后使用该指纹的扩展安装会被拒绝。</p>
          </div>
        </div>
        <span className="publisher-trust-count">{publishers.length} 个发布者</span>
      </div>
      <div className="publisher-trust-list">
        {publishers.map((publisher) => <SettingsResourceCard className="publisher-trust-publisher" key={publisher.publisher}>
          <header>
            <strong>{publisher.publisher}</strong>
            <span>{publisher.keys.filter((key) => key.status === 'trusted').length} 个有效公钥</span>
          </header>
          {publisher.keys.map((key) => <div className={`publisher-trust-key is-${key.status}`} key={key.keyId}>
            <span className="publisher-trust-icon">
              {key.status === 'trusted' ? <ShieldCheck /> : <ShieldX />}
            </span>
            <span className="publisher-trust-key-main">
              <code title={key.keyId}>{key.keyId}</code>
              <small>
                {key.status === 'trusted' ? '受信任' : '已撤销'}
                {key.createdAt ? ` · 信任于 ${dateText(key.createdAt)}` : ''}
                {key.source ? ` · ${key.source}` : ''}
              </small>
            </span>
            {key.status === 'trusted' && <button
              type="button"
              className="settings-text-button is-danger"
              disabled={busy}
              onClick={() => setPending({ publisher: publisher.publisher, key })}
            >撤销</button>}
          </div>)}
        </SettingsResourceCard>)}
      </div>
      {error && <div className="dialog-error" role="alert">{error}</div>}
    </section>

    {pending && <SettingsDialog
      title="撤销发布者公钥？"
      description={`撤销后，${pending.publisher} 使用此指纹签名的扩展将不能继续安装。这个操作不可恢复。`}
      action="撤销公钥"
      busy={busy}
      loading={false}
      error={error}
      showBackdrop={false}
      onClose={() => {
        if (!busy) setPending(null);
      }}
      onSubmit={() => void revoke()}
    >
      <div className="publisher-revoke-summary">
        <ShieldX />
        <div>
          <strong>{pending.publisher}</strong>
          <code>{pending.key.keyId}</code>
        </div>
      </div>
    </SettingsDialog>}
  </>;
}
