import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Clapperboard, LoaderCircle, Sparkles, X } from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import { errorText } from '../../shared/error-text';
import type { StoryboardDraftPreview, StoryboardPlan, StoryboardWork } from '../../types/storyboard-types';
import { settleStoryboardDrafts } from './storyboard-drafts';
import { StoryboardDraftReview } from './StoryboardDraftReview';
import { StoryboardTextModel, useStoryboardTextModel } from './StoryboardTextModel';
import './styles/storyboard-draft.css';

type Props = {
  workspace: string; work: StoryboardWork; plan: StoryboardPlan; shotId?: string; number?: number;
  modelRef: string; onModel: (id: string) => void; onWork: (work: StoryboardWork) => void;
  onConfigureModels: () => void; onClose: () => void;
  initialGeneration?: Promise<StoryboardDraftPreview>;
};

export function StoryboardDraftDialog({ workspace, work, plan, shotId, number, modelRef, onModel, onWork, onConfigureModels, onClose, initialGeneration }: Props) {
  const model = useStoryboardTextModel(workspace, modelRef);
  const [instruction, setInstruction] = useState('');
  const [preview, setPreview] = useState<StoryboardDraftPreview | null>(null);
  const [busy, setBusy] = useState<'generate' | 'apply' | null>(initialGeneration ? 'generate' : null);
  const [error, setError] = useState('');
  const active = useRef(true);
  const inFlight = useRef(false);
  const token = useRef('');
  const workId = work.id;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (token.current) void window.piApi.storyboardDiscardDraft(workspace, workId, token.current).catch(() => {});
    };
  }, [workspace, workId]);
  useEffect(() => {
    if (!initialGeneration) return;
    let visible = true;
    void initialGeneration.then(next => {
      if (visible) { token.current = next.id; setPreview(next); }
    }).catch(cause => { if (visible) setError(errorText(cause)); })
      .finally(() => { if (visible) setBusy(null); });
    return () => { visible = false; };
  }, [initialGeneration]);
  const selected = model.selected;
  const step = work.document.nodes.find(node => node.id === plan.nodeId)?.step;
  const shot = work.document.shots.find(item => item.id === shotId);
  const target = shotId ? '镜头 ' + String(number).padStart(2, '0') : '整套分镜';
  const allowed = Boolean(selected && (!shotId || instruction.trim()));
  const inputs = work.document.shots.filter(item => item.planId === plan.id && (!shotId || item.id === shotId));
  const inputIds = new Set(inputs.map(item => item.id));
  const assetIds = new Set([...plan.assetIds, ...inputs.flatMap(item => item.assetIds),
    ...work.document.tracks.flatMap(track => track.clips.filter(clip => inputIds.has(clip.shotId)).map(clip => clip.assetId))]);
  const materials = work.document.assets.filter(asset => assetIds.has(asset.id));

  function revise() {
    if (token.current) void window.piApi.storyboardDiscardDraft(workspace, workId, token.current).catch(() => {});
    token.current = '';
    setPreview(null);
    setError('');
  }
  async function submit() {
    if (busy || inFlight.current || (!preview && !allowed)) return;
    inFlight.current = true;
    setBusy(preview ? 'apply' : 'generate');
    setError('');
    try {
      await settleStoryboardDrafts(workspace, workId);
      if (!active.current) return;
      if (preview) {
        const next = await window.piApi.storyboardApplyDraft(workspace, workId, preview.id);
        token.current = '';
        if (active.current) { onWork(next); onClose(); }
      } else {
        const next = await window.piApi.storyboardGenerateDraft(workspace, workId, {
          planId: plan.id, shotId, instruction: instruction.trim(), modelRef: selected!.id,
        });
        if (active.current) {
          token.current = next.id;
          setPreview(next);
        } else {
          void window.piApi.storyboardDiscardDraft(workspace, workId, next.id).catch(() => {});
        }
      }
    } catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { inFlight.current = false; if (active.current) setBusy(null); }
  }
  const label = preview ? (shotId ? '应用这一镜' : '应用整套分镜') : (shotId ? '生成修改建议' : '生成分镜建议');
  const title = preview ? target + ' · 建议预览' : shotId ? 'AI 修改' + target : 'AI 生成整套分镜';
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!bodyRef.current) return;
    bodyRef.current.scrollTop = 0;
    if (preview) bodyRef.current.querySelector<HTMLElement>('[aria-label="分镜建议预览"]')?.focus({ preventScroll: true });
  }, [preview]);
  return <DetailDialog className={'story-draft-dialog' + (preview ? ' is-reviewing' : '')}
    onClose={() => { if (busy !== 'apply') onClose(); }}>
    <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      <header className="dialog-header"><div><h2>{title}</h2><p>{work.document.title || '分镜作品'} · 第 {plan.version} 版</p></div>
        <button className="icon-button" type="button" aria-label="关闭分镜建议" disabled={busy === 'apply'} onClick={onClose}><X /></button></header>
      <div className="dialog-body" ref={bodyRef}>
        {preview ? <StoryboardDraftReview workspace={workspace} work={work} planId={plan.id} preview={preview} shot={shot} number={number} />
          : <fieldset disabled={Boolean(busy)} className="story-draft-form">
            <div className="story-draft-context"><Clapperboard aria-hidden /><div>
              <strong>{shot?.purpose || step?.direction?.title || work.document.title}</strong>
              <p>{shotId ? plan.summary : step?.brief.focus || step?.brief.idea || plan.summary}</p>
              {materials.length ? <details className="story-draft-materials">
                <summary>查看 {materials.length} 份关联素材</summary>
                <ul>{materials.map(asset => <li key={asset.id}>{asset.name}</li>)}</ul>
              </details> : <small>将按已确认的想法与方案编排</small>}
            </div></div>
            <StoryboardTextModel label="分镜文本模型" state={model} onModel={onModel} disabled={Boolean(busy)}
              onConfigure={() => { onClose(); onConfigureModels(); }} />
            <label className="story-field"><span>{shotId ? '修改要求' : '补充分镜要求（选填）'}</span>
              <textarea autoFocus rows={3} maxLength={4000} value={instruction} onChange={e => setInstruction(e.target.value)}
                placeholder={shotId ? '例如，把这一镜改成慢推近，字幕缩短到一句。' : '例如，做成 15 秒的演示，让观众看清关键操作。'} /></label>
            <p className="story-draft-disclosure">{selected?.supportsImages ? '模型可参考素材名称、文稿节选和最多 6 张图片缩略图。' : '模型可参考素材名称、文稿节选和镜头说明。'}
              视频和录音仅提供名称及已有说明。</p>
          </fieldset>}
      </div>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <footer className="dialog-footer">
        {preview && <button className="story-draft-revise" type="button" disabled={Boolean(busy)} onClick={revise}><ArrowLeft />调整要求</button>}
        <button className="settings-outline" type="button" disabled={busy === 'apply'} onClick={onClose}>
          {preview ? '放弃建议' : busy ? '关闭' : '取消'}</button>
        <button type="submit" className="settings-save" disabled={Boolean(busy) || (!preview && !allowed)}>
          {busy ? <LoaderCircle className="story-draft-spin" aria-hidden /> : !preview && <Sparkles aria-hidden />}
          {busy === 'generate' ? '正在编排分镜…' : busy === 'apply' ? '正在应用…' : label}</button>
      </footer>
    </form>
  </DetailDialog>;
}
