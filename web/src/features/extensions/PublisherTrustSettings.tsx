import { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, ShieldX, X } from 'lucide-react';
import type {
  ExtensionPublisherTrustKey,
  ExtensionPublisherTrustSnapshot,
} from '../../types/extension-types';
import { useSettingsToast } from '../../shared/SettingsToast';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { DetailDialog } from '../../shared/DetailDialog';
import { SettingsResourceCard } from '../../shared/SettingsResourceCard';

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function dateText(timestamp: number | undefined) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString();
}

export function PublisherTrustSettings() {
  const [snapshot, setSnapshot] = useState<ExtensionPublisherTrustSnapshot | null>(null);
  const showToast = useSettingsToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
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
        if (active) showToast(errorText(reason), 'error');
      });
    return () => {
      active = false;
    };
  }, [showToast]);

  async function revoke() {
    if (!pending) return;
    setBusy(true);
    try {
      const next = await window.piApi.revokeExtensionPublisherKey({
        publisher: pending.publisher,
        keyId: pending.key.keyId,
      });
      setSnapshot(next);
      setPending(null);
      showToast('发布者公钥已撤销');
    } catch (reason) {
      showToast(errorText(reason), 'error');
    } finally {
      setBusy(false);
    }
  }

  const publishers = (snapshot?.publishers || []).filter((item) => item.keys.length > 0);
  if (!snapshot || publishers.length === 0) return null;

  return <>
    <button type="button" className="extension-library-tool" aria-haspopup="dialog"
      onClick={() => setOpen(true)}><KeyRound aria-hidden="true" />发布者公钥</button>
    {open && <DetailDialog className="publisher-trust-dialog" onClose={() => setOpen(false)}>{close => <>
      <header className="detail-header">
        <div className="detail-heading"><div>
          <h2>发布者公钥</h2>
          <p>共 {publishers.length} 个发布者。Ed25519 公钥用于确认签名者身份。</p>
        </div></div>
        <button type="button" className="icon-button" aria-label="关闭发布者公钥" onClick={close}><X /></button>
      </header>
      <div className="detail-body publisher-trust-list">
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
    </>}</DetailDialog>}

    {pending && <SettingsDialog
      title="撤销发布者公钥？"
      description={`撤销后，${pending.publisher} 使用此指纹签名的扩展将不能继续安装。这个操作不可恢复。`}
      action="撤销公钥"
      busy={busy}
      loading={false}
      error={null}
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
