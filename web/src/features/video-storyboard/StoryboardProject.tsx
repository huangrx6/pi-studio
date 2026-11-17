import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Clapperboard, GitBranch } from 'lucide-react';
import type { ProductionInput, StoryboardDraftPreview, StoryboardPlan, StoryboardWork } from '../../types/storyboard-types';
import { errorText } from '../../shared/error-text';
import { Select } from '../../shared/Select';
import { StoryboardEditor } from './StoryboardEditor';
import { ProductionDesk } from './ProductionDesk';
import { StoryboardDraftDialog } from './StoryboardDraftDialog';
import { settleStoryboardDrafts } from './storyboard-drafts';
import './styles/production.css';

function Handoff({ work, plan, base, busy, onStart, onBack }: {
  work: StoryboardWork; plan: StoryboardPlan; base: StoryboardPlan; busy: boolean;
  onStart: (input: ProductionInput) => void; onBack: () => void;
}) {
  const [reuse, setReuse] = useState<Record<number, string>>({});
  const step = work.document.nodes.find(node => node.id === plan.nodeId)?.step;
  const beats = step?.direction?.beats.length ? step.direction.beats : [step?.direction?.title || plan.summary];
  const previous = work.document.shots.filter(shot => shot.planId === base.id);
  return <section className="story-handoff" aria-label="核对新版分镜">
    <header><h3>准备第 {plan.version} 版分镜</h3><p>新方案有 {beats.length} 个镜头。选择需要沿用的旧镜头，其余按新方案起稿。</p></header>
    <ol>{beats.map((beat, index) => <li className="story-handoff-row" key={index}>
      <span className="story-handoff-number" aria-hidden>{String(index + 1).padStart(2, '0')}</span>
      <div><strong>{beat}</strong>
        <small>{previous[index] ? `原镜头 · ${previous[index].purpose || '未命名镜头'} · ${previous[index].durationMs / 1000} 秒` : '新增镜头'}</small></div>
      <Select label={`镜头 ${index + 1} 的起稿方式`} value={reuse[index] || ''}
        options={[{ value: '', label: '按新方案起稿' }, ...previous.map((shot, i) => ({
          value: shot.id, label: `沿用 ${i + 1} · ${shot.purpose || '未命名镜头'}`,
          disabled: Object.entries(reuse).some(([key, value]) => Number(key) !== index && value === shot.id),
        }))]} onChange={value => setReuse(items => ({ ...items, [index]: value }))} />
    </li>)}</ol>
    {previous.length > beats.length && <small>旧版还有 {previous.length - beats.length} 个镜头，可从上方列表选用。</small>}
    <div className="story-handoff-actions"><button className="secondary-button" disabled={busy} onClick={onBack}><ArrowLeft />返回讨论</button>
      <button className="primary-button" disabled={busy}
      onClick={() => onStart({ planId: plan.id, reuse: Object.entries(reuse).filter(([, value]) => value).map(([i, shotId]) => ({ index: Number(i), shotId })) })}>
      建立新版分镜<ArrowRight /></button></div>
  </section>;
}

type View = { desk: boolean; planId: string; shotId: string };
export function StoryboardProject({ work, workspace, onWork, onRename, onConfigureModels, settingsOpen }: {
  work: StoryboardWork; workspace: string; onWork: (work: StoryboardWork) => void; onRename: (title: string) => void;
  onConfigureModels: () => void; settingsOpen: boolean;
}) {
  const doc = work.document;
  const drafts = doc.plans.filter(plan => doc.shots.some(shot => shot.planId === plan.id));
  const key = 'studio.storyboard.view:' + work.id;
  const [view, setView] = useState<View>(() => {
    try { const saved = JSON.parse(localStorage.getItem(key) || 'null'); if (saved && drafts.some(p => p.id === saved.planId)) return saved; }
    catch { /* Use the most recent draft when the window has no saved view. */ }
    return { desk: Boolean(drafts.length), planId: drafts.at(-1)?.id || '', shotId: '' };
  });
  const plan = drafts.find(item => item.id === view.planId) ?? drafts.at(-1);
  const [handoff, setHandoff] = useState('');
  const [generation, setGeneration] = useState<{ planId: string; result: Promise<StoryboardDraftPreview> } | null>(null);
  const [draftModel, setDraftModel] = useState('');
  useEffect(() => () => {
    if (generation) void generation.result.then(candidate =>
      window.piApi.storyboardDiscardDraft(workspace, work.id, candidate.id)).catch(() => {});
  }, [generation, workspace, work.id]);
  const pending = doc.plans.find(item => item.id === handoff && item.id === doc.approvedPlanId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  function go(next: View) {
    setView(next);
    localStorage.setItem(key, JSON.stringify(next));
  }
  async function switchView(desk: boolean, planId = view.planId) {
    if (lock.current || (desk === view.desk && planId === view.planId && !handoff)) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await settleStoryboardDrafts(workspace, work.id);
      onWork(await window.piApi.storyboardRead(workspace, work.id));
      setHandoff('');
      go({ desk, planId, shotId: planId === view.planId ? view.shotId : '' });
    } catch (cause) { setError(errorText(cause)); }
    finally { lock.current = false; setBusy(false); }
  }
  async function start(input: ProductionInput) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await settleStoryboardDrafts(workspace, work.id);
      const next = await window.piApi.storyboardProduce(workspace, work.id, input);
      onWork(next);
      setHandoff('');
      go({ desk: true, planId: input.planId, shotId: '' });
    } catch (cause) { setError(errorText(cause)); }
    finally { lock.current = false; setBusy(false); }
  }
  function enter(planId: string) {
    setError('');
    if (drafts.some(item => item.id === planId)) void switchView(true, planId);
    else if (plan) setHandoff(planId);
    else void start({ planId });
  }
  function openConfirmedPlan(planId: string, modelRef: string, generate: boolean) {
    setError('');
    setHandoff('');
    go({ desk: true, planId, shotId: '' });
    if (generate) {
      setDraftModel(modelRef);
      const result = window.piApi.storyboardGenerateDraft(workspace, work.id, { planId, modelRef });
      void result.catch(() => {});
      setGeneration({ planId, result });
    }
  }
  return <>
    {plan && <nav className="story-view-switch" aria-label="作品视图">
      <button aria-pressed={!view.desk} disabled={busy} onClick={() => void switchView(false)}><GitBranch aria-hidden />创作流程</button>
      <button aria-pressed={view.desk} disabled={busy} onClick={() => void switchView(true)}><Clapperboard aria-hidden />制作工作台</button>
    </nav>}
    {error && <p role="alert" className="story-error">{error}</p>}
    {pending && plan ? <Handoff work={work} plan={pending} base={plan} busy={busy} onStart={start} onBack={() => setHandoff('')} />
      : view.desk && plan ? <ProductionDesk work={work} workspace={workspace} plan={plan} drafts={drafts} shotId={view.shotId} onWork={onWork}
          settingsOpen={settingsOpen} onConfigureModels={onConfigureModels}
          onSelect={(planId, shotId) => go({ desk: true, planId, shotId })} />
      : <fieldset disabled={busy} className="story-work-controls"><StoryboardEditor work={work} workspace={workspace}
          onWork={onWork} onRename={onRename} onProduce={enter} onConfirmed={openConfirmedPlan}
          settingsOpen={settingsOpen} onConfigureModels={onConfigureModels} /></fieldset>}
    {generation && plan?.id === generation.planId && <StoryboardDraftDialog work={work} workspace={workspace} plan={plan}
      modelRef={draftModel} onModel={setDraftModel} onWork={onWork} onConfigureModels={onConfigureModels}
      initialGeneration={generation.result} onClose={() => setGeneration(null)} />}
  </>;
}
