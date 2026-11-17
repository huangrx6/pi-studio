import { useState } from 'react';
import { FileText, FileVideo, Image, Music2, Plus, Upload } from 'lucide-react';
import { errorText } from '../../shared/error-text';
import { formatFileSize } from '../../shared/filesize';
import type { ShotPatch, StoryboardAsset, StoryboardDirection, StoryboardShot, StoryboardTrack, StoryboardWork } from '../../types/storyboard-types';
import { SourcePreview } from './SourcePreview';
import { ShotMediaGenerator } from './ShotMediaGenerator';

const kindIcon = { image: Image, video: FileVideo, audio: Music2, document: FileText };
const kindLabel = { image: '图片', video: '视频', audio: '音频', document: '文稿' };
const roleLabel = { narration: '旁白', original: '原声', music: '配乐', effect: '音效' };

export function ShotAssets({ work, workspace, shot, needed, edit, onWork, settingsOpen, onConfigureModels }: {
  work: StoryboardWork; workspace: string; shot: StoryboardShot; needed?: StoryboardDirection['need'];
  edit: (patch: ShotPatch) => void; onWork: (next: StoryboardWork) => void;
  settingsOpen: boolean; onConfigureModels: () => void;
}) {
  const assets = work.document.assets;
  const scheduled = new Map<string, { role: StoryboardTrack['role']; clip: StoryboardTrack['clips'][number] }>();
  for (const track of work.document.tracks) {
    for (const clip of track.clips) {
      if (clip.shotId === shot.id && !scheduled.has(clip.assetId)) scheduled.set(clip.assetId, { role: track.role, clip });
    }
  }
  const muted = shot.composition?.mutedAudioIds ?? [];
  function usesAsset(asset: StoryboardAsset) {
    return asset.kind === 'audio' && scheduled.has(asset.id) ? !muted.includes(asset.id) : shot.assetIds.includes(asset.id);
  }
  const used = assets.filter(usesAsset);
  const [showAll, setShowAll] = useState(used.length === 0);
  const [previewId, setPreviewId] = useState(shot.assetIds[0] ?? used[0]?.id ?? '');
  const [pickError, setPickError] = useState('');
  const [adding, setAdding] = useState(false);
  const matched = needed && used.filter(asset => needed.kinds.includes(asset.kind)).length >= needed.count;
  const allVisible = showAll || !used.length;
  const visibleAssets = allVisible ? assets : used;
  const preview = visibleAssets.find(asset => asset.id === previewId) ?? (!allVisible ? used[0] : undefined);
  function toggle(asset: StoryboardAsset, checked: boolean) {
    if (asset.kind === 'audio' && scheduled.has(asset.id)) {
      edit({ composition: { ...shot.composition, mutedAudioIds: checked ? muted.filter(id => id !== asset.id) : [...muted, asset.id] } });
    } else {
      edit({ assetIds: checked ? [...shot.assetIds, asset.id] : shot.assetIds.filter(id => id !== asset.id) });
    }
    if (checked) setPreviewId(asset.id);
    else if (!allVisible && previewId === asset.id && used.length > 1) setPreviewId(used.find(item => item.id !== asset.id)!.id);
  }
  async function add() {
    setAdding(true); setPickError('');
    try {
      const next = await window.piApi.storyboardPick(workspace, work.id);
      onWork(next);
      const added = next.document.assets.find(asset => !assets.some(item => item.id === asset.id));
      if (added) { setShowAll(true); setPreviewId(added.id); }
    } catch (cause) { setPickError(errorText(cause)); }
    finally { setAdding(false); }
  }
  return <section className="story-shot-library" aria-label="镜头素材">
    <header className="story-shot-subhead"><h4>镜头素材</h4>
      <button type="button" className="story-asset-import" aria-label="导入作品素材" onClick={add} disabled={adding}><Plus />导入</button></header>
    {needed && <p className="story-gap">{matched ? '已补齐' : '待补'} · {needed.label}</p>}
    <ShotMediaGenerator workspace={workspace} work={work} shot={shot} onWork={onWork}
      settingsOpen={settingsOpen} onConfigureModels={onConfigureModels} />
    {assets.length === 0 ? <button className="story-dropzone" disabled={adding} onClick={add}><Upload /><strong>为这个镜头添加素材</strong></button> : <>
      <div className="story-library-filter" role="group" aria-label="筛选镜头素材">
        <button type="button" disabled={!used.length} aria-pressed={!allVisible} onClick={() => {
          setShowAll(false);
          if (!used.some(asset => asset.id === previewId)) setPreviewId(used[0]?.id ?? '');
        }}>本镜使用 <span>{used.length}</span></button>
        <button type="button" aria-pressed={allVisible} onClick={() => setShowAll(true)}>全部素材 <span>{assets.length}</span></button>
      </div>
      <ul className="story-library-items">{visibleAssets.map(asset => {
        const Icon = kindIcon[asset.kind], cue = scheduled.get(asset.id);
        const info = cue ? `${roleLabel[cue.role]} · ${cue.clip.offsetMs / 1000} 秒进入` : `${kindLabel[asset.kind]} · ${formatFileSize(asset.size)}`;
        return <li key={asset.id} data-preview={preview?.id === asset.id}>
          <input type="checkbox" aria-label={`此镜使用 ${asset.name}`} checked={usesAsset(asset)} onChange={event => toggle(asset, event.target.checked)} />
          <button type="button" aria-label={`预览 ${asset.name}`} aria-pressed={preview?.id === asset.id} onClick={() => setPreviewId(asset.id)}>
            <Icon aria-hidden /><span><strong title={asset.name}>{asset.name}</strong><small>{info}</small></span></button>
        </li>;
      })}</ul>
    </>}
    {preview && <SourcePreview key={preview.id} asset={preview} workId={work.id} workspace={workspace} onWork={onWork} />}
    {pickError && <p className="story-error" role="alert">{pickError}</p>}
  </section>;
}
