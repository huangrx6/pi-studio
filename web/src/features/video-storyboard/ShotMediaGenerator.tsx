import { useEffect, useId, useRef, useState } from 'react';
import { AudioLines, ImagePlus, LoaderCircle, Settings2 } from 'lucide-react';
import { Select } from '../../shared/Select';
import { errorText } from '../../shared/error-text';
import type { MediaKind, MediaModelCatalog, MediaModelRef, StoryboardShot, StoryboardWork } from '../../types/storyboard-types';
import { ShotMediaCandidate } from './ShotMediaCandidate';
import { useShotMediaJob } from './shot-media-jobs';
import './styles/shot-media.css';

type Props = {
  workspace: string; work: StoryboardWork; shot: StoryboardShot;
  onWork: (next: StoryboardWork) => void; settingsOpen: boolean; onConfigureModels: () => void;
};

function modelKey(model?: MediaModelRef) { return model ? JSON.stringify([model.providerId, model.modelId]) : ''; }

export function ShotMediaGenerator(props: Props) {
  const [kind, setKind] = useState<MediaKind | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<MediaKind, string>>>({});
  const id = useId();
  function toggle(next: MediaKind) { setKind(current => current === next ? null : next); }
  const shot = props.shot;
  const prompt = kind === 'speech' ? shot.captions.map(cue => cue.text.trim()).filter(Boolean).join('\n')
    : [shot.purpose, shot.subjects, shot.setting, shot.framing].map(text => text.trim()).filter(Boolean).join('\n');
  return <div className="story-media-generator">
    <div className="story-media-kinds" role="group" aria-label="生成镜头素材">
      <button type="button" aria-controls={kind === 'speech' ? id : undefined} aria-expanded={kind === 'speech'} onClick={() => toggle('speech')}>
        <AudioLines aria-hidden />模型配音</button>
      <button type="button" aria-controls={kind === 'image' ? id : undefined} aria-expanded={kind === 'image'} onClick={() => toggle('image')}>
        <ImagePlus aria-hidden />模型生图</button>
    </div>
    {kind && <div id={id}><MediaForm key={kind} {...props} kind={kind} prompt={drafts[kind] ?? prompt}
      changePrompt={value => setDrafts(current => ({ ...current, [kind]: value }))} /></div>}
  </div>;
}

function MediaForm({ workspace, work, shot, onWork, settingsOpen, onConfigureModels, kind, prompt, changePrompt }: Props & {
  kind: MediaKind; prompt: string; changePrompt: (value: string) => void;
}) {
  const speech = kind === 'speech';
  const [catalog, setCatalog] = useState<MediaModelCatalog | null>(null);
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [voiceDraft, setVoiceDraft] = useState<string | null>(null);
  const [savingModel, setSavingModel] = useState('');
  const preferenceWrite = useRef<Promise<unknown> | null>(null);
  const { pending, generate } = useShotMediaJob(workspace, work.id, shot.id, kind);
  useEffect(() => {
    if (settingsOpen) return;
    let active = true;
    setReadError('');
    void window.piApi.storyboardMediaModels().then(next => { if (active) setCatalog(next); })
      .catch(cause => { if (active) { setCatalog(null); setReadError(errorText(cause)); } });
    return () => { active = false; };
  }, [settingsOpen, reload]);
  useEffect(() => {
    if (!pending) return;
    let active = true;
    void pending.then(result => { if (active) onWork(result.work); }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [pending, onWork]);

  const preference = work.document.mediaPreferences?.[kind];
  const choices = catalog?.[kind] ?? [];
  const selected = choices.find(item => modelKey(item) === modelKey(preference));
  const voice = voiceDraft ?? work.document.mediaPreferences?.speech?.voice ?? '';
  const candidates = work.document.assets.filter(asset => asset.generated?.shotId === shot.id && asset.generated.kind === kind);
  const knownVoices = speech && selected ? Array.from(new Set(work.document.assets.flatMap(({ generated }) =>
    generated?.kind === 'speech' && modelKey(generated) === modelKey(selected) && generated.voice ? [generated.voice] : []))) : [];
  const maxLength = speech ? 4096 : 16000;
  const changingModel = savingModel && savingModel !== modelKey(preference);
  const canGenerate = Boolean(!changingModel && selected && (!speech || voice.trim()) && prompt.trim() && prompt.trim().length <= maxLength);

  async function savePreference(model: MediaModelRef, nextVoice?: string) {
    setSavingModel(modelKey(model)); setError('');
    const ref = { providerId: model.providerId, modelId: model.modelId };
    const write = window.piApi.storyboardMediaPreferences(workspace, work.id, speech ? { speech: { ...ref, voice: nextVoice?.trim() } } : { image: ref });
    preferenceWrite.current = write;
    try { onWork(await write); return true; }
    catch (cause) { setError(errorText(cause)); return false; }
    finally {
      if (preferenceWrite.current === write) { preferenceWrite.current = null; setSavingModel(''); }
    }
  }
  async function create() {
    if (!selected || pending || !canGenerate) return;
    setError('');
    try {
      if (preferenceWrite.current) await preferenceWrite.current;
      else if (speech && voice.trim() !== work.document.mediaPreferences?.speech?.voice) {
        const saved = await savePreference(selected, voice);
        if (!saved) return;
      }
      const result = await generate({ kind, shotId: shot.id, providerId: selected.providerId, modelId: selected.modelId,
        prompt: prompt.trim(), ...(speech ? { voice: voice.trim() } : {}) });
      onWork(result.work);
    } catch (cause) { setError(errorText(cause)); }
  }
  return <section className="story-media-form" aria-label={speech ? '生成本镜旁白' : '生成本镜画面'}>
    {readError ? <div className="story-media-empty"><p className="story-error" role="alert">{readError}</p>
      <button type="button" className="secondary-button" onClick={() => setReload(value => value + 1)}>重新读取模型</button></div>
      : !catalog ? <p className="story-note" role="status">正在读取模型…</p>
      : !choices.length ? <div className="story-media-empty">
        <p>还没有配置{speech ? '语音合成' : '图像生成'}模型。</p>
        <button type="button" className="secondary-button" onClick={onConfigureModels}><Settings2 aria-hidden />配置模型</button></div>
      : <>
        <div className="story-media-model-fields" data-speech={speech}>
          <div className="story-field"><span>{speech ? '语音模型' : '图像模型'}</span>
            <Select label={speech ? '本作品语音模型' : '本作品图像模型'} placeholder="选择已配置的模型" disabled={Boolean(savingModel || pending)}
              value={modelKey(selected)} options={choices.map(model => ({ value: modelKey(model), label: model.label }))}
              onChange={key => {
                const next = choices.find(item => modelKey(item) === key);
                if (next && key !== modelKey(selected)) { setVoiceDraft(null); void savePreference(next); }
              }} />
          </div>
          {speech && <VoiceField key={modelKey(selected)} modelId={selected?.modelId} history={knownVoices} value={voice} disabled={Boolean(savingModel || pending)}
            onChange={setVoiceDraft} onCommit={next => {
              if (selected && next.trim() !== (work.document.mediaPreferences?.speech?.voice ?? '')) void savePreference(selected, next);
            }} />}
        </div>
        {preference && !selected && <p className="story-note">原选模型 {preference.modelId} 已停用，请重新选择。</p>}
        <label className="story-field"><span>{speech ? '旁白文稿' : '画面描述'}</span>
          <textarea rows={3} value={prompt} maxLength={maxLength} onChange={event => changePrompt(event.target.value)}
            placeholder={speech ? '输入希望在这一镜听到的话' : '描述主体、场景、光线与画面风格'} /></label>
        {prompt.trim().length > maxLength && <p className="story-note">请将内容缩短到 {maxLength} 字以内。</p>}
        <div className="story-media-generate-row"><small>模型{speech ? '和音色' : ''}随作品保存</small>
          <button type="button" className="primary-button" disabled={!canGenerate || Boolean(pending)} onClick={() => void create()}>
            {pending ? <LoaderCircle aria-hidden className="is-generating" /> : speech ? <AudioLines aria-hidden /> : <ImagePlus aria-hidden />}
            {pending ? '正在生成…' : speech ? '生成旁白' : '生成画面'}</button></div>
      </>}
    {error && <p role="alert" className="story-error">{error}</p>}
    {candidates.length > 0 && <ShotMediaCandidate key={candidates[candidates.length - 1].id} workspace={workspace} work={work}
      shot={shot} onWork={onWork} candidates={candidates} models={choices} kind={kind} />}
  </section>;
}

const classicVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
function VoiceField({ modelId, history, value, disabled, onChange, onCommit }: {
  modelId?: string; history: string[]; value: string; disabled: boolean;
  onChange: (next: string) => void; onCommit: (next: string) => void;
}) {
  const [custom, setCustom] = useState(false);
  const builtIn = modelId === 'tts-1' || modelId === 'tts-1-hd' ? classicVoices
    : modelId && /^gpt-4o-mini-tts(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)
      ? ['marin', 'cedar', 'coral', 'ash', 'ballad', 'sage', 'verse', ...classicVoices] : [];
  const voices = [...new Set([...history, ...builtIn])];
  const useCustom = custom || !voices.length || Boolean(value && !voices.includes(value));
  const id = useId();
  return <div className="story-field"><span>旁白音色</span>
    {voices.length > 0 && <Select label="选择旁白音色" value={useCustom ? id : value} placeholder="选择音色"
      options={[...voices.map(voice => ({ value: voice, label: voice })), { value: id, label: '自定义音色…' }]}
      disabled={disabled} onChange={next => {
        setCustom(next === id);
        if (next !== id) { onChange(next); onCommit(next); }
      }} />}
    {useCustom && <input type="text" aria-label="本作品旁白音色" value={value} disabled={!modelId || disabled} maxLength={256}
      placeholder="填写模型支持的音色 ID" onChange={event => onChange(event.target.value)} onBlur={() => onCommit(value)} />}
  </div>;
}
