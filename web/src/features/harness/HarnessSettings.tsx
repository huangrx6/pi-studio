import { useEffect, useRef, useState } from 'react';
import { Plus, SlidersHorizontal, Undo2 } from 'lucide-react';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { errorText } from '../../shared/error-text';
import { LoadingState } from '../../shared/LoadingState';
import { useDeferredEnter } from '../../shared/useDeferredEnter';
import { runtimeRefreshFailure } from '../../shared/runtime-refresh';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { useSettingsDraftGuard } from '../../shared/SettingsDraftGuard';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { automaticProfileIcon } from '../../shared/profile-icon';
import { SettingsProfileLibrary } from '../../shared/SettingsProfileLibrary';
import { useSettingsToast } from '../../shared/SettingsToast';
import type { HarnessProfile, HarnessSettingsSnapshot } from '../../types/harness-types';
import { HarnessProfileEditor, type HarnessScope } from './HarnessProfileEditor';
import { HarnessRuntimeFields } from './HarnessRuntimeFields';
import { cloneRuntimePolicy, createHarnessRequestOwner, createHarnessWriteQueue, type CommitHarnessChange } from './harness-state';
import './styles/harness-settings.css';

const harnessWrites = createHarnessWriteQueue();
const cachedHarnessByCwd = new Map<string, HarnessSettingsSnapshot>();
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
  return <><SettingsDialog wide title="全局运行策略" description="所有 Harness 方案共用。"
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
  const seeded = initial ?? cachedHarnessByCwd.get(cwd);
  const [snapshot, setSnapshot] = useState(seeded);
  const [loading, setLoading] = useState(!seeded);
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
    cachedHarnessByCwd.set(cwd, next);
    setSnapshot(next);
    updated.current?.(next);
  }
  useEffect(() => {
    cachedHarnessByCwd.set(cwd, snapshot);
  }, [cwd, snapshot]);
  async function reload(explicit = false) {
    const ticket = owner.begin();
    if (explicit || !cachedHarnessByCwd.get(cwd)) setLoading(true);
    setLoadError('');
    try {
      await harnessWrites.wait();
      if (!owner.current(ticket)) return;
      const next = await window.piApi.harnessSettings(cwd);
      if (owner.current(ticket)) accept(next);
    } catch (cause) {
      if (owner.current(ticket) && !cachedHarnessByCwd.get(cwd)) setLoadError(errorText(cause));
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
  const workspaceReveal = useDeferredEnter(ready);
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
    }, scope === 'global'
      ? '已设为全局默认。'
      : scope === 'inherit'
        ? '当前工作区已恢复继承。'
        : scope === 'temporary'
          ? '已设为临时对话默认方案。'
          : '已应用到当前工作区，下一条请求生效。');
  }

  function createProfile() {
    const source = snapshot.profiles.find(profile => profile.id === snapshot.activeProfileId) ?? snapshot.profiles[0] ?? {
      id: '', name: '', builtin: false, customInstructions: '', sectionOverrides: {}, toolGuidance: {},
      sections: Object.fromEntries(snapshot.sections.map(section => [section.id, true])) as HarnessProfile['sections'],
    };
    open({ kind: 'create', source: { ...source, icon: null } });
  }
  return <div className="settings-preference-page harness-settings">
    <SettingsPageHeader title="Harness 配置" iconPosition="end" meta="编排系统提示词与全局运行策略。"
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
      {loading && <div className="settings-loading-card"><LoadingState variant="section">正在刷新 Harness 配置…</LoadingState></div>}
      {loadError && <div className="settings-load-error"><p role="alert">{loadError}</p>
        <button type="button" className="settings-outline" onClick={() => void reload(true)}>重新加载 Harness 配置</button></div>}
      {ready && (() => {
        const bindingFor = (profile: HarnessProfile) => {
          const global = profile.id === snapshot.globalProfileId;
          return [
            global && '全局默认',
            cwd && (profile.id === snapshot.workspaceProfileId
              ? '当前工作区'
              : global && !snapshot.workspaceProfileId && '工作区继承'),
            profile.id === snapshot.temporaryProfileId && '临时对话',
          ].filter(Boolean).join(' · ');
        };
        const activeHero = snapshot.profiles.find(p => p.id === snapshot.activeProfileId)
          ?? snapshot.profiles.find(p => p.id === snapshot.globalProfileId)
          ?? snapshot.profiles[0];
        const others = snapshot.profiles.filter(p => p.id !== activeHero?.id);

        return <div className={`harness-workspace${workspaceReveal ? ' settings-async-ready' : ''}`}>
          {activeHero && (() => {
            const binding = bindingFor(activeHero);
            const enabled = snapshot.sections.filter(s => activeHero.sections[s.id] !== false).length;
            const guidanceCount = Object.keys(activeHero.toolGuidance).length;
            return <button
              type="button"
              className="settings-preference-card harness-stage"
              aria-label={'编辑' + activeHero.name}
              aria-haspopup="dialog"
              onClick={() => open({ kind: 'edit', source: activeHero })}
            >
              <div className="harness-stage-head">
                <div className="harness-stage-identity">
                  {binding && <span className="harness-live-kicker"><i aria-hidden="true" />{binding}</span>}
                  <div className="harness-stage-title-row">
                    <strong>{activeHero.name}</strong>
                    <code>{activeHero.id}</code>
                  </div>
                </div>
              </div>

              <div className="harness-patchbay" aria-label="提示词模块装配槽">
                {snapshot.sections.map((section, idx) => {
                  const on = activeHero.sections[section.id] !== false;
                  const num = String(idx + 1).padStart(2, '0');
                  return <div key={section.id} className={`harness-slot${on ? ' is-on' : ''}`}>
                    <span className="harness-slot-num">{num}</span>
                    <span className="harness-slot-label">{section.label || section.id}</span>
                    <i className="harness-slot-led" aria-hidden="true" />
                  </div>;
                })}
              </div>

              <div className="harness-stage-meta">
                <span>{enabled} / {snapshot.sections.length} 段系统提示词</span>
                {guidanceCount > 0 && <span>{guidanceCount} 条工具使用说明</span>}
                {activeHero.customInstructions?.trim() && <span>已配置自定义指令</span>}
              </div>
            </button>;
          })()}

          {others.length > 0 && <div className="settings-preference-card harness-deck" role="list" aria-label="其他配置方案">
            {others.map(profile => {
              const binding = bindingFor(profile);
              const enabled = snapshot.sections.filter(s => profile.sections[s.id] !== false).length;
              const guidanceCount = Object.keys(profile.toolGuidance).length;
              return <button
                key={profile.id}
                type="button"
                role="listitem"
                className="harness-deck-row"
                aria-label={'编辑' + profile.name}
                aria-haspopup="dialog"
                onClick={() => open({ kind: 'edit', source: profile })}
              >
                <span className="harness-fingerprint" aria-hidden="true">
                  {snapshot.sections.map(section => (
                    <i key={section.id} className={profile.sections[section.id] !== false ? 'is-on' : ''} />
                  ))}
                </span>
                <div className="harness-deck-copy">
                  <div className="harness-deck-head">
                    <strong>{profile.name}</strong>
                    {binding && <span className="harness-live-kicker"><i aria-hidden="true" />{binding}</span>}
                  </div>
                  <small>{profile.id}{guidanceCount > 0 ? ` · ${guidanceCount} 条工具说明` : ''}</small>
                </div>
                <span className="harness-deck-ratio">{enabled} / {snapshot.sections.length}</span>
              </button>;
            })}
          </div>}
        </div>;
      })()}
    </SettingsProfileLibrary>
    {editor?.kind === 'policy' && <HarnessPolicyDialog snapshot={snapshot} busy={busy} commit={commit} cwd={cwd}
      onClose={() => { close(); onCompactionRevealed?.(); }} onCompactionRevealed={onCompactionRevealed} />}
    {editor && editor.kind !== 'policy' && <HarnessProfileEditor key={editor.kind + ':' + editor.source.id} creating={editor.kind === 'create'}
      source={editor.source} snapshot={snapshot} cwd={cwd} enabledTools={enabledTools} busy={busy} commit={commit}
      onClose={close} onApply={apply} onCopy={source => open({ kind: 'create',
        source: { ...source, icon: source.icon ?? automaticProfileIcon('harness', source.id) } })} />}
  </div>;
}
