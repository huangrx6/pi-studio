import { useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { Select } from '../../shared/Select';
import { errorText } from '../../shared/error-text';
import type { MediaKind, MediaModelCatalog, StoryboardAsset, StoryboardShot, StoryboardWork } from '../../types/storyboard-types';
import { SourcePreview } from './SourcePreview';
import { settleStoryboardDrafts } from './storyboard-drafts';

export function ShotMediaCandidate({ candidates, models, kind, workspace, work, shot, onWork }: {
  candidates: StoryboardAsset[]; models: MediaModelCatalog[MediaKind]; kind: MediaKind; workspace: string; work: StoryboardWork; shot: StoryboardShot;
  onWork: (next: StoryboardWork) => void;
}) {
  const [selected, setSelected] = useState('');
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const asset = candidates.find(item => item.id === selected) ?? candidates[candidates.length - 1];
  if (!asset?.generated) return null;
  const { providerId, modelId, voice } = asset.generated;
  const source = models.find(model => model.providerId === providerId && model.modelId === modelId)?.label ?? providerId + ' · ' + modelId;
  const narration = work.document.tracks.filter(track => track.role === 'narration').flatMap(track => track.clips.filter(clip => clip.shotId === shot.id));
  const used = kind === 'image' ? shot.assetIds.includes(asset.id)
    : narration.some(clip => clip.assetId === asset.id) && !shot.composition?.mutedAudioIds?.includes(asset.id);
  const entry = narration.length ? Math.min(...narration.map(clip => clip.offsetMs)) : 0;
  const duration = asset.generated.durationMs ?? 0;
  const extendsShot = kind === 'speech' && !used && duration > 0 && entry + duration > shot.durationMs;
  async function apply() {
    if (lock.current) return;
    lock.current = true; setError(''); setApplying(true);
    try {
      await settleStoryboardDrafts(workspace, work.id);
      onWork(await window.piApi.storyboardApplyMedia(workspace, work.id, { shotId: shot.id, assetId: asset.id }));
    } catch (cause) { setError(errorText(cause)); }
    finally { lock.current = false; setApplying(false); }
  }
  return <section className="story-media-candidate" aria-label={kind === 'speech' ? '候选旁白' : '候选画面'}>
    <header><strong>{kind === 'speech' ? '旁白试听' : '生成的画面'}</strong>
      {candidates.length > 1 && <Select label="候选版本" value={asset.id} disabled={applying}
        options={candidates.map((item, i) => ({ value: item.id, label: `第 ${i + 1} 版` })).reverse()}
        onChange={id => { setError(''); setSelected(id); }} />}</header>
    <small>{source}{voice ? ' · ' + voice : ''}</small>
    <SourcePreview key={asset.id} asset={asset} workId={work.id} workspace={workspace} onWork={onWork} />
    <div className="story-media-use"><button type="button" className="secondary-button" onClick={apply} disabled={applying || used}>
      <Check aria-hidden />{used ? '本镜已采用' : applying ? '正在采用…' : '采用到本镜'}
    </button>{extendsShot && <small>采用后本镜将从 {shot.durationMs / 1000} 秒延长至 {(entry + duration) / 1000} 秒。</small>}</div>
    {error && <p className="story-error" role="alert">{error}</p>}
  </section>;
}
