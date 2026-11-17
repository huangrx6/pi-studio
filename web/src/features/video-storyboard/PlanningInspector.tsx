import { useState } from 'react';
import { ArrowRight, Check, ChevronRight, GitBranch, Paperclip } from 'lucide-react';
import type { StoryboardNode, StoryboardReplyAction, StoryboardWork } from '../../types/storyboard-types';
import { StoryboardMaterials } from './StoryboardMaterials';

type Props = {
  node: StoryboardNode; work: StoryboardWork; workspace: string; busy: boolean; ai: boolean;
  working: boolean; onMaterialsChanging: (changing: boolean) => void;
  reply: (action: StoryboardReplyAction) => void; onWork: (work: StoryboardWork) => void;
  onProduce: (planId: string) => void;
};
function AnswerForm({ onAnswer, label, submit, busy }: {
  onAnswer: (text: string) => void; label: string; submit: string; busy: boolean;
}) {
  const [text, setText] = useState('');
  return <form className="story-answer" onSubmit={event => { event.preventDefault(); if (text.trim()) onAnswer(text.trim()); }}>
    <label className="story-field"><span>{label}</span>
      <textarea value={text} aria-label={label} maxLength={4000} onChange={event => setText(event.target.value)} /></label>
    <button className="primary-button" disabled={busy || !text.trim()}>{submit}<ArrowRight /></button>
  </form>;
}

function MaterialReply({ node, work, workspace, reply, onWork, busy, working, onMaterialsChanging, ai }: Props) {
  const [ids, setIds] = useState<string[]>([]);
  const need = node.step?.direction?.need;
  if (!need) return null;
  const candidates = work.document.assets.filter(asset => need.kinds.includes(asset.kind));
  const selected = ids.filter(id => candidates.some(asset => asset.id === id));
  return <>
    <StoryboardMaterials workspace={workspace} work={work} onWork={onWork} disabled={working} onChanging={onMaterialsChanging} selection={{
      need, ids: selected,
      toggle: id => setIds(need.count === 1 ? [id] : selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]),
    }} />
    <div className="story-actions">
      {candidates.length > 0 && <button className="primary-button" disabled={busy || selected.length !== need.count}
        onClick={() => reply({ action: 'materials', assetIds: selected })}>使用所选素材</button>}
      <button className="secondary-button" disabled={busy} onClick={() => reply({ action: 'defer' })}>记为待补</button>
    </div>
    {ai && <details className="story-own-direction"><summary>讨论替代素材</summary>
      <AnswerForm label="可用的替代素材或想法" submit="请 AI 建议" busy={busy} onAnswer={text => reply({ action: 'answer', text })} /></details>}
  </>;
}

export function PlanningInspector(props: Props) {
  const { node, work, reply, busy, ai } = props;
  const step = node.step;
  const plan = work.document.plans.find(item => item.id === node.chosenPlanId);
  const approved = Boolean(plan && plan.id === work.document.approvedPlanId);
  const produced = plan && work.document.shots.some(shot => shot.planId === plan.id);
  if (!step) return <div className="story-inspector"><h3>{node.question}</h3><p>{node.answer}</p></div>;
  const used = work.document.assets.filter(asset => node.assetIds.includes(asset.id));
  return <section className="story-inspector">
    <header><h3>{node.question}</h3><p>{step.reason}</p></header>
    {node.kind === 'question' && <AnswerForm label="你的想法" submit={ai ? '发送回答' : '看看叙事方向'}
      busy={busy} onAnswer={text => reply({ action: 'answer', text })} />}
    {node.kind === 'direction' && <>
      {(step.brief.focus || step.brief.idea) && <blockquote className="story-prompt-excerpt">{step.brief.focus || step.brief.idea}</blockquote>}
      <div className="story-directions">{step.options?.map(option =>
        <button type="button" key={option.id} disabled={busy} onClick={() => reply({ action: 'choose', choiceId: option.id })}>
          <span><strong>{option.title}</strong><small>{option.beats.join(' → ')}</small>
            {option.need && <small className="story-direction-need"><Paperclip aria-hidden />{option.need.label}</small>}</span><ChevronRight aria-hidden />
        </button>)}</div>
      <details className="story-own-direction"><summary>我有自己的讲法</summary>
        <AnswerForm label="自定义叙事方向" submit="采用这个讲法" busy={busy} onAnswer={text => reply({ action: 'answer', text })} /></details>
    </>}
    {node.kind === 'materials' && <MaterialReply {...props} />}
    {node.kind === 'review' && step.direction && <>
      <dl className="story-review">
        {step.brief.idea && <><dt>创作想法</dt><dd>{step.brief.idea}</dd></>}
        {step.brief.focus && <><dt>补充想法</dt><dd>{step.brief.focus}</dd></>}
        <dt>叙事方向</dt><dd>{step.direction.title}</dd>
        {step.direction.beats.length > 0 && <><dt>叙事顺序</dt><dd><ol>{step.direction.beats.map((beat, index) => <li key={index}>{beat}</li>)}</ol></dd></>}
        <dt>画幅</dt><dd>{step.brief.aspect === 'auto' ? '稍后决定' : step.brief.aspect}</dd>
        {used.length > 0 && <><dt>拟用素材</dt><dd>{used.length > 3
          ? <details><summary>{used.length} 份素材</summary>{used.map(asset => <div key={asset.id}>{asset.name}</div>)}</details>
          : used.map(asset => asset.name).join('、')}</dd></>}
        {step.deferred && <><dt>待补素材</dt><dd>{step.deferred}</dd></>}
      </dl>
      {ai && <details className="story-own-direction"><summary>我想调整方案</summary>
        <AnswerForm label="修改方案的要求" submit="请 AI 调整方案" busy={busy}
          onAnswer={text => reply({ action: 'answer', text })} /></details>}
      <div className="story-actions">
        {ai && !(approved && produced) && <button className="primary-button" disabled={busy} onClick={() => reply({ action: 'approve' })}>
          <Check />{produced ? `采用第 ${plan.version} 版并继续制作` : '确认方案并生成分镜'}</button>}
        {!ai && <button className={approved ? 'secondary-button' : 'primary-button'} disabled={busy || approved} onClick={() => reply({ action: 'approve' })}>
          <Check />{plan ? (approved ? `已确认 · 第 ${plan.version} 版` : `采用第 ${plan.version} 版`) : '确认这份方案'}</button>}
        {approved && plan && (!ai || produced) && <button className="primary-button" disabled={props.working} onClick={() => props.onProduce(plan.id)}>
          {produced ? '继续制作' : '开始制作'}<ArrowRight /></button>}
      </div>
    </>}
    {(node.kind === 'direction' || node.kind === 'review') && <button className="story-explore" disabled={busy}
      onClick={() => reply({ action: 'explore' })}><GitBranch />继续头脑风暴</button>}
  </section>;
}
