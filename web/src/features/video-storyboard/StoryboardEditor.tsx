import { Accordion } from '../../shared/Accordion';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowRight, Check, ChevronDown, ChevronRight, GitBranch, RotateCcw, Sparkles } from 'lucide-react';
import { errorText } from '../../shared/error-text';
import { StoryboardBriefForm } from './StoryboardBriefForm';
import { StoryboardCanvas, stepIcons, stepLabels } from './StoryboardCanvas';
import { PlanningInspector } from './PlanningInspector';
import './styles/planning.css';
import type { StoryboardBrief, StoryboardReplyAction, StoryboardWork } from '../../types/storyboard-types';
import { briefWriter } from './storyboard-drafts';
import { StoryboardMaterials } from './StoryboardMaterials';
import { StoryboardTextModel, useStoryboardTextModel } from './StoryboardTextModel';

export function StoryboardEditor({ workspace, work, onRename, onWork, onProduce, onConfirmed, onConfigureModels, settingsOpen }: {
  workspace: string; work: StoryboardWork; onRename: (title: string) => void; onWork: (next: StoryboardWork) => void;
  onProduce: (planId: string) => void;
  onConfirmed: (planId: string, modelRef: string, generate: boolean) => void;
  onConfigureModels: () => void; settingsOpen: boolean;
}) {
  const writer = useMemo(() => briefWriter(workspace, work.id), [workspace, work.id]);
  const status = useSyncExternalStore(writer.subscribe, writer.status);
  const doc = work.document;
  const [brief, setBrief] = useState<StoryboardBrief>(() => ({
    title: doc.title, genre: doc.genre, aspect: doc.aspect, idea: doc.nodes[0].answer, ...writer.pending(),
  }));
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changingMaterials, setChangingMaterials] = useState(false);
  const [error, setError] = useState('');
  const modeKey = 'studio.storyboard.planning-mode:' + work.id;
  const [mode, setMode] = useState<'basic' | 'ai'>(() => localStorage.getItem(modeKey) === 'basic' ? 'basic' : 'ai');
  const [chosenModel, setChosenModel] = useState('');
  const lock = useRef(false);
  const active = useRef(true);
  const retry = useRef<{ key: string; id: string; action: StoryboardReplyAction }>();
  const selected = doc.nodes.find(node => node.id === (viewedId ?? doc.activeNodeId)) ?? doc.nodes[0];
  const model = useStoryboardTextModel(workspace, chosenModel || selected.step?.modelRef || '', settingsOpen);
  const ai = mode === 'ai';
  const blocked = busy || changingMaterials || (ai && !model.selected);
  const children = doc.nodes.filter(node => node.parentId === selected.id);
  const editor = useRef<HTMLDivElement>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const [wide, setWide] = useState(false);
  const [mapChoice, setMapChoice] = useState<{ wide: boolean; open: boolean } | null>(null);
  const mapOpen = mapChoice?.wide === wide ? mapChoice.open : wide && doc.nodes.length > 1;
  const mapId = useId();
  const StageIcon = stepIcons[selected.kind];
  useLayoutEffect(() => {
    const element = editor.current!;
    const measure = () => setWide(element.clientWidth >= 700);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  function select(id: string) {
    if (lock.current || changingMaterials) return;
    setError('');
    setChosenModel('');
    setViewedId(id);
    if (!wide) {
      setMapChoice({ wide, open: false });
      stepHeading.current?.focus({ preventScroll: true });
      stepHeading.current?.scrollIntoView({ block: 'nearest' });
    }
  }
  async function advance(action: StoryboardReplyAction) {
    if (lock.current || blocked) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const modelRef = ai ? model.selected?.id : undefined;
    const key = JSON.stringify([selected.id, action, mode, modelRef, selected.kind === 'idea' ? brief : null,
      doc.assets.map(asset => asset.id)]);
    if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID(), action };
    try {
      await writer.flush();
      if (writer.failed()) throw new Error(writer.status());
      const next = await window.piApi.storyboardAdvance(workspace, work.id, {
        ...action, parentId: selected.id, requestId: retry.current.id, mode, modelRef,
      });
      retry.current = undefined;
      if (!active.current) return;
      onWork(next);
      setViewedId(null);
      if (modelRef && action.action === 'approve') {
        const planId = next.document.nodes.find(node => node.id === selected.id)?.chosenPlanId;
        if (planId) onConfirmed(planId, modelRef, next.productionCreated === true);
      }
    } catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  useEffect(() => {
    active.current = true;
    const flush = () => { void writer.flush(); };
    window.addEventListener('pagehide', flush);
    return () => { active.current = false; window.removeEventListener('pagehide', flush); };
  }, [writer]);
  function edit(patch: Partial<StoryboardBrief>) {
    setBrief(current => ({ ...current, ...patch }));
    writer.edit(patch);
    if (patch.title !== undefined) onRename(patch.title);
  }
  return <div ref={editor} className="story-editor story-planner" data-wide={wide}>
    <header className="story-editor-head">
      <h2 ref={stepHeading} tabIndex={-1}><StageIcon aria-hidden />{stepLabels[selected.kind]}</h2>
      <div className="story-plan-tools">
        {writer.failed()
          ? <button className="secondary-button" onClick={() => void writer.flush()}>重试保存</button>
          : <small role="status">{!busy && status === '已保存' && <Check aria-hidden />}{busy ? (ai ? '正在整理方案…' : '正在更新流程…') : status}</small>}
        <button className="story-map-switch" aria-label={mapOpen ? '收起流程图' : '显示流程图'} aria-expanded={mapOpen}
          aria-controls={mapOpen ? mapId : undefined} onClick={() => setMapChoice({ wide, open: !mapOpen })}>
          <GitBranch aria-hidden />流程图<span>{doc.nodes.length}</span><ChevronDown aria-hidden />
        </button>
      </div>
    </header>
    {writer.failed() && <p className="story-error" role="alert">{status}</p>}
    <div className="story-planning-layout" data-map-open={mapOpen}>
      {mapOpen && <StoryboardCanvas id={mapId} doc={doc} selected={selected} rootText={brief.idea} onSelect={select} />}
      <div className="story-node-detail">
        <div className="story-planning-model">
          {ai ? <StoryboardTextModel label="创作文本模型" state={model} onModel={setChosenModel}
            onConfigure={onConfigureModels} disabled={busy} /> : <span>基础流程</span>}
          <button type="button" className="story-explore" disabled={busy} onClick={() => {
            const next = ai ? 'basic' : 'ai';
            setMode(next);
            localStorage.setItem(modeKey, next);
            setError('');
          }}>{ai ? '使用基础流程' : '使用 AI 策划'}</button>
        </div>
        {selected.id !== doc.activeNodeId && <button className="story-resume" onClick={() => select(doc.activeNodeId)}>
          <RotateCcw aria-hidden />回到当前步骤</button>}
        <fieldset className="story-work-controls" disabled={busy} aria-busy={busy}>
          {selected.kind === 'idea' ? <section className="story-start-sheet">
            <StoryboardBriefForm brief={brief} question={selected.question} edit={edit} onBlur={() => void writer.flush()} />
            <StoryboardMaterials workspace={workspace} work={work} onWork={onWork} disabled={busy} onChanging={setChangingMaterials} />
            <div className="story-actions story-start-actions">
              {ai && model.selected && doc.assets.length > 0 && <small className="story-planning-references">
                {model.selected.supportsImages ? '讨论时会参考素材名称、文稿节选和图片缩略图。' : '讨论时会参考素材名称和文稿节选。'}
              </small>}
              <button className="primary-button" disabled={blocked} onClick={() => void advance({ action: 'start' })}>{ai ? '和 AI 讨论' : '讨论叙事方向'}<ArrowRight /></button>
              <button className="story-explore" disabled={blocked} onClick={() => void advance({ action: 'explore' })}><Sparkles aria-hidden />一起找灵感</button>
            </div>
          </section> : <PlanningInspector key={selected.id} node={selected} work={work} workspace={workspace} ai={ai}
            busy={blocked} working={busy} onMaterialsChanging={setChangingMaterials} reply={advance} onWork={onWork} onProduce={onProduce} />}
        </fieldset>
        {error && <div className="story-step-error" role="alert"><span className="story-error">{error}</span>
          {retry.current && <button className="secondary-button" disabled={blocked}
            onClick={() => { if (retry.current) void advance(retry.current.action); }}>重试此步</button>}</div>}
        {children.length > 0 && <Accordion key={selected.id} className="story-replies" summary="此前的回复" badge={children.length} compact>
          {children.map(child => <button key={child.id} disabled={busy} onClick={() => select(child.id)}>
            <GitBranch aria-hidden /><span>{child.step?.reply || child.answer || stepLabels[child.kind]}</span><ChevronRight aria-hidden /></button>)}
        </Accordion>}
      </div>
    </div>
  </div>;
}
