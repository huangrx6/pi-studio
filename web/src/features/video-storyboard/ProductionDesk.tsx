import { Accordion } from '../../shared/Accordion';
import { useMemo, useReducer, useState, useSyncExternalStore } from 'react';
import { ChevronLeft, ChevronRight, ListVideo, NotebookPen, Sparkles } from 'lucide-react';
import { Select } from '../../shared/Select';
import type { ShotPatch, StoryboardPlan, StoryboardShot, StoryboardWork } from '../../types/storyboard-types';
import { shotWriter } from './storyboard-drafts';
import { ShotComposition } from './ShotComposition';
import { ShotAssets } from './ShotAssets';
import { ShotNavigator } from './ShotNavigator';
import { FilmPlayer } from './FilmPlayer';
import { StoryboardDraftDialog } from './StoryboardDraftDialog';
import './styles/shot-editor.css';

type Props = {
  work: StoryboardWork; workspace: string; onWork: (work: StoryboardWork) => void;
  settingsOpen: boolean; onConfigureModels: () => void;
};
const fields = { framing: '景别与构图', subjects: '人物或物件', setting: '场景', motion: '动作与运镜', sound: '原声与声音设计' } as const;

function ShotEditor({ work, workspace, shot, index, plan, onWork, settingsOpen, onConfigureModels }: Props & { shot: StoryboardShot; index: number; plan: StoryboardPlan }) {
  const writer = useMemo(() => shotWriter(workspace, work.id, shot.id, onWork), [workspace, work.id, shot.id, onWork]);
  const status = useSyncExternalStore(writer.subscribe, writer.status);
  const [, redraw] = useReducer(value => value + 1, 0);
  const draft = { ...shot, ...writer.pending() };
  const [seconds, setSeconds] = useState<string | null>(null);
  const step = work.document.nodes.find(node => node.id === plan.nodeId)?.step;
  const needed = step?.deferred && index === (step.direction?.id === 'compare' ? 1 : 0) ? step.direction?.need : undefined;
  function edit(patch: ShotPatch) {
    writer.edit(patch);
    redraw();
  }
  return <div className="story-shot-sheet">
    <div className="story-shot-fields">
      <div className="story-shot-basics">
        <label className="story-field"><span>镜头意图</span><input value={draft.purpose} maxLength={16000}
          onChange={event => edit({ purpose: event.target.value })} onBlur={() => void writer.flush()} /></label>
        <label className="story-field"><span>时长（秒）</span><input type="number" step="0.001" min="0.001" max="3600"
          value={seconds ?? String(draft.durationMs / 1000)} onChange={event => {
            const text = event.target.value;
            setSeconds(text);
            const ms = Math.round(Number(text) * 1000);
            if (event.target.validity.valid && ms > 0) edit({ durationMs: ms });
          }} onBlur={() => { setSeconds(null); void writer.flush(); }} /></label>
      </div>
      <ShotComposition shot={draft} edit={edit} />
      <Accordion className="story-shot-disclosure" summary={<><NotebookPen aria-hidden /><span>画面与声音设计</span></>}>
        <div className="story-shot-note-fields">{(Object.keys(fields) as (keyof typeof fields)[]).map(key => <label className="story-field" key={key}><span>{fields[key]}</span>
          <textarea rows={2} value={draft[key]} maxLength={16000} onChange={event => edit({ [key]: event.target.value })} onBlur={() => void writer.flush()} />
        </label>)}</div>
      </Accordion>
      {writer.failed() ? <div className="story-shot-save"><p className="story-error" role="alert">{status}</p>
        <button className="secondary-button" onClick={() => void writer.flush()}>重试保存</button></div> : <small className="story-shot-saved" role="status">{status}</small>}
    </div>
    <ShotAssets workspace={workspace} work={work} shot={draft} needed={needed || undefined} edit={edit} onWork={onWork}
      settingsOpen={settingsOpen} onConfigureModels={onConfigureModels} />
  </div>;
}

export function ProductionDesk({ work, workspace, onWork, plan, drafts, shotId, onSelect, settingsOpen, onConfigureModels }: Props & {
  plan: StoryboardPlan; drafts: StoryboardPlan[]; shotId: string; onSelect: (planId: string, shotId: string) => void;
}) {
  const shots = work.document.shots.filter(shot => shot.planId === plan.id);
  const selected = Math.max(0, shots.findIndex(shot => shot.id === shotId));
  const shot = shots[selected];
  const step = work.document.nodes.find(node => node.id === plan.nodeId)?.step;
  const select = (id: string) => onSelect(plan.id, id);
  const [draftTarget, setDraftTarget] = useState<{ shotId?: string; number?: number } | null>(null);
  const [draftModel, setDraftModel] = useState('');
  return <section className="story-production" aria-label="制作中的分镜">
    <header className="story-production-head"><div>
      <h3>{step?.direction?.title || work.document.title || '分镜草稿'}</h3>
      <small>{shots.length} 镜 · {Number((shots.reduce((sum, item) => sum + item.durationMs, 0) / 1000).toFixed(3))} 秒{step?.brief.aspect && step.brief.aspect !== 'auto' ? ' · ' + step.brief.aspect : ''}</small>
    </div><div className="story-production-actions">
      {drafts.length > 1 ? <Select label="制作方案版本" value={plan.id} options={drafts.map(p => ({ value: p.id, label: `第 ${p.version} 版` }))}
        onChange={id => onSelect(id, '')} /> : <small>第 {plan.version} 版</small>}
      <button className="secondary-button" type="button" onClick={() => setDraftTarget({})}><Sparkles aria-hidden />AI 生成整套分镜</button>
    </div></header>
    <div className="story-production-grid">
      <ShotNavigator workspace={workspace} workId={work.id} assets={work.document.assets} shots={shots} selected={selected} select={select} />
      <FilmPlayer key={plan.id} work={work} workspace={workspace} planId={plan.id} selectedId={shot?.id} select={select} />
      {shot && <section className="story-shot-inspector" aria-label="单镜编辑">
        <header className="story-inspector-head"><ListVideo aria-hidden /><h3>编辑镜头 {String(selected + 1).padStart(2, '0')}</h3>
          <div className="story-stepper">
            <button className="story-ai-shot" type="button" onClick={() => setDraftTarget({ shotId: shot.id, number: selected + 1 })}>
              <Sparkles aria-hidden />AI 改这一镜</button>
            <button className="icon-button" aria-label="编辑上一镜" title="编辑上一镜" disabled={selected === 0}
              onClick={() => select(shots[selected - 1].id)}><ChevronLeft /></button>
            <button className="icon-button" aria-label="编辑下一镜" title="编辑下一镜" disabled={selected === shots.length - 1}
              onClick={() => select(shots[selected + 1].id)}><ChevronRight /></button>
          </div>
        </header>
        <ShotEditor key={shot.id} workspace={workspace} work={work} plan={plan} shot={shot} index={selected} onWork={onWork}
          settingsOpen={settingsOpen} onConfigureModels={onConfigureModels} />
      </section>}
    </div>
    {draftTarget && <StoryboardDraftDialog work={work} workspace={workspace} plan={plan} shotId={draftTarget.shotId}
      number={draftTarget.number} modelRef={draftModel || step?.modelRef || ''} onModel={setDraftModel} onWork={onWork}
      onConfigureModels={onConfigureModels} onClose={() => setDraftTarget(null)} />}
  </section>;
}
