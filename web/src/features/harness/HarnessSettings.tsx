import { useEffect, useRef, useState } from 'react';
import { Check, Plus, SlidersHorizontal, Undo2 } from 'lucide-react';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { errorText } from '../../shared/error-text';
import { LoadingState } from '../../shared/LoadingState';
import { runtimeRefreshFailure } from '../../shared/runtime-refresh';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { SettingsProfileCard, SettingsProfileLibrary } from '../../shared/SettingsProfileLibrary';
import { useSettingsToast } from '../../shared/SettingsToast';
import type { HarnessProfile, HarnessSettingsSnapshot } from '../../types/harness-types';
import { HarnessProfileEditor, type HarnessScope } from './HarnessProfileEditor';
import { automaticHarnessIcon, HarnessProfileMark } from './HarnessProfileMark';
import { HarnessRuntimeFields } from './HarnessRuntimeFields';
import { cloneRuntimePolicy, createHarnessRequestOwner, createHarnessWriteQueue, type CommitHarnessChange } from './harness-state';
import './styles/harness-settings.css';

const harnessWrites = createHarnessWriteQueue();
class HarnessReloadError extends Error {}
type Editor = { kind: 'create' | 'edit'; source: HarnessProfile } | { kind: 'policy' };

function HarnessPolicyDialog({ snapshot, busy, commit, onClose, onCompactionRevealed, cwd }: {
  snapshot: HarnessSettingsSnapshot; busy: boolean; commit: CommitHarnessChange; onClose: () => void;
  onCompactionRevealed?: () => void; cwd: string;
}) {
  const [draft, setDraft] = useState(() => cloneRuntimePolicy(snapshot.runtimePolicy));
  const confirmation = useActionConfirmation();
  const dirty = JSON.stringify(draft) !== JSON.stringify(snapshot.runtimePolicy);
  useSettingsDraftGuard({ label: '全局运行策略', dirty });
  const compactionSwitch = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!onCompactionRevealed) return;
    const frame = requestAnimationFrame(() => {
      const button = compactionSwitch.current;
      const section = button?.closest('details');
      const body = section?.closest<HTMLElement>('.dialog-body');
      if (!button || !section || !body) return;
      section.open = true;
      body.scrollTop += section.getBoundingClientRect().top - body.getBoundingClientRect().top - parseFloat(getComputedStyle(body).paddingBlockStart);
      button.focus({ preventScroll: true });
      onCompactionRevealed();
    });
    return () => cancelAnimationFrame(frame);
  }, [onCompactionRevealed]);
  return <><SettingsDialog wide title="全局运行策略" description="所有 Harness 方案共用。保存后，下一次请求会使用新策略。"
    action="保存策略" loading={false} busy={busy} unavailable={!dirty} error={null} onClose={onClose}
    autoFocusFirstField={false} onRequestClose={async dismiss => {
      if (!dirty || await confirmation.confirm({ title: '放弃未保存的策略更改？', confirmLabel: '放弃更改', tone: 'danger' })) await dismiss(onClose);
    }}
    onSubmit={dismiss => void commit(() => window.piApi.saveRuntimePolicy({ cwd, policy: draft }), '全局运行策略已保存。', () => dismiss(onClose))}
    footerHint={() => <button type="button" className="settings-text-button harness-more" disabled={busy}
      onClick={() => setDraft(cloneRuntimePolicy(snapshot.runtimePolicyDefaults))}><Undo2 aria-hidden="true" />恢复默认值</button>}>
    <div className="harness-policy-editor"><HarnessRuntimeFields policy={draft} setPolicy={setDraft}
      compactionSwitch={compactionSwitch} revealCompaction={Boolean(onCompactionRevealed)} /></div>
  </SettingsDialog>{confirmation.dialog}</>;
}

export function HarnessSettings({ cwd, initial, enabledTools, onUpdated, onCompactionRevealed }: {
  cwd: string; initial: HarnessSettingsSnapshot; enabledTools: string[];
  onUpdated?: (snapshot: HarnessSettingsSnapshot) => void; onCompactionRevealed?: () => void;
}) {
  const showToast = useSettingsToast();
  const [snapshot, setSnapshot] = useState(initial);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const policyButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const owner = useRef(createHarnessRequestOwner(cwd)).current;
  owner.setScope(cwd);
  const mutationLock = useRef(false);
  const updated = useRef(onUpdated);
  updated.current = onUpdated;

  function accept(next: HarnessSettingsSnapshot) {
    setSnapshot(next);
    updated.current?.(next);
  }
  async function reload() {
    const ticket = owner.begin();
    setLoading(true);
    setLoadError('');
    try {
      await harnessWrites.wait();
      if (!owner.current(ticket)) return;
      const next = await window.piApi.harnessSettings(cwd);
      if (owner.current(ticket)) accept(next);
    } catch (cause) {
      if (owner.current(ticket)) setLoadError(errorText(cause));
    } finally {
      if (owner.current(ticket)) setLoading(false);
    }
  }
  useEffect(() => {
    owner.activate();
    void reload();
    return () => owner.dispose();
  }, [cwd]);

  const ready = !loading && !loadError;
  function open(next: Editor) {
    if (!editor) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditor(next);
  }
  function close() {
    setEditor(null);
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) {
        const target = opener.current?.isConnected ? opener.current : createButton.current;
        target?.focus({ preventScroll: true });
      }
    });
  }
  useEffect(() => {
    if (ready && onCompactionRevealed) {
      policyButton.current?.focus({ preventScroll: true });
      opener.current = policyButton.current;
      setEditor({ kind: 'policy' });
    }
  }, [onCompactionRevealed, ready]);

  const commit: CommitHarnessChange = async (write, success, finish) => {
    if (!ready || mutationLock.current) return;
    const ticket = owner.begin();
    if (ticket.cwd !== cwd || !owner.current(ticket)) return;
    mutationLock.current = true;
    setBusy(true);
    try {
      const next = await harnessWrites.run(write);
      if (!owner.current(ticket)) return;
      accept(next);
      if (finish) await finish();
      if (!owner.current(ticket)) return;
      const warning = runtimeRefreshFailure(next.runtimeRefresh);
      showToast(success + (warning || ''), warning ? 'error' : 'success');
    } catch (cause) {
      if (!owner.current(ticket)) return;
      if (cause instanceof HarnessReloadError) { close(); setLoadError(cause.message); }
      else showToast(errorText(cause), 'error');
    } finally {
      if (owner.current(ticket)) { mutationLock.current = false; setBusy(false); }
    }
  };
  function apply(id: string, scope: HarnessScope) {
    void commit(async () => {
      const next = await window.piApi.selectHarnessProfile({ cwd, id, scope });
      if (scope !== 'global' || !cwd) return next;
      try { return { ...await window.piApi.harnessSettings(cwd), runtimeRefresh: next.runtimeRefresh }; }
      catch (cause) { throw new HarnessReloadError('全局默认已保存，但读取当前工作区配置失败。' + errorText(cause)); }
    }, scope === 'global' ? '已设为全局默认。' : scope === 'inherit' ? '当前工作区已恢复继承。' : '已应用到当前工作区，下一条请求生效。');
  }

  function createProfile() {
    const source = snapshot.profiles.find(profile => profile.id === snapshot.activeProfileId) ?? snapshot.profiles[0] ?? {
      id: '', name: '', builtin: false, customInstructions: '', sectionOverrides: {}, toolGuidance: {},
      sections: Object.fromEntries(snapshot.sections.map(section => [section.id, true])) as HarnessProfile['sections'],
    };
    open({ kind: 'create', source: { ...source, icon: null } });
  }
  return <div className="settings-preference-page harness-settings">
    <SettingsPageHeader title="Harness 配置" iconPosition="end" meta="编排系统提示词，设置请求、工具和上下文的运行方式。"
      icon={<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="5" width="27" height="22" rx="4" /><path d="M3 11.5h26M9 16l-3 3 3 3m14-6 3 3-3 3" />
        <path d="m17.5 15.5-3 7" stroke="var(--accent)" />
      </svg>} />
    <SettingsProfileLibrary title="配置方案" count={ready ? snapshot.profiles.length : 0} actions={<>
      <button ref={policyButton} type="button" className="settings-outline" aria-haspopup="dialog" disabled={!ready}
        onClick={() => open({ kind: 'policy' })}><SlidersHorizontal aria-hidden="true" />全局运行策略</button>
      <button ref={createButton} type="button" className="settings-save" aria-haspopup="dialog" disabled={!ready}
        onClick={createProfile}><Plus aria-hidden="true" />新建配置</button>
    </>}>
      {loading && <LoadingState variant="section">正在刷新 Harness 配置…</LoadingState>}
      {loadError && <div className="settings-preference-card harness-load-error"><p role="alert">{loadError}</p>
        <button type="button" className="settings-outline" onClick={() => void reload()}>重新加载 Harness 配置</button></div>}
      {ready && <div className="settings-profile-grid">{snapshot.profiles.map(profile => {
        const global = profile.id === snapshot.globalProfileId;
        const binding = [global && '全局默认', cwd && (profile.id === snapshot.workspaceProfileId ? '当前工作区使用'
          : global && !snapshot.workspaceProfileId && '当前工作区继承')].filter(Boolean).join(' · ');
        const enabled = snapshot.sections.filter(section => profile.sections[section.id] !== false).length;
        const guidanceCount = Object.keys(profile.toolGuidance).length;
        return <SettingsProfileCard key={profile.id} name={profile.name}
          icon={<HarnessProfileMark icon={profile.icon ?? automaticHarnessIcon(profile.id, profile.builtin)} />}
          subtitle={(profile.builtin ? '内置 · ' : '') + profile.id}
          description={<span className="harness-card-meta">
            {binding && <span className="harness-binding"><Check aria-hidden="true" />{binding}</span>}
            <span className="harness-coverage-bar" aria-hidden="true">
              {snapshot.sections.map(section => <i key={section.id} className={profile.sections[section.id] !== false ? 'is-on' : ''} />)}
            </span>
          </span>}
          summary={[`${enabled}/${snapshot.sections.length} 段提示词`, guidanceCount > 0 && guidanceCount + ' 条工具说明'].filter(Boolean).join(' · ')}
          onEdit={() => open({ kind: 'edit', source: profile })} />;
      })}</div>}
    </SettingsProfileLibrary>
    {editor?.kind === 'policy' && <HarnessPolicyDialog snapshot={snapshot} busy={busy} commit={commit} cwd={cwd}
      onClose={() => { close(); onCompactionRevealed?.(); }} onCompactionRevealed={onCompactionRevealed} />}
    {editor && editor.kind !== 'policy' && <HarnessProfileEditor key={editor.kind + ':' + editor.source.id} creating={editor.kind === 'create'}
      source={editor.source} snapshot={snapshot} cwd={cwd} enabledTools={enabledTools} busy={busy} commit={commit}
      onClose={close} onApply={apply} onCopy={source => open({ kind: 'create',
        source: { ...source, icon: source.icon ?? automaticHarnessIcon(source.id, source.builtin) } })} />}
  </div>;
}
