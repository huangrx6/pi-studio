import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { StoryboardAsset, StoryboardDraftPreview, StoryboardShot, StoryboardWork } from '../../types/storyboard-types';
import { FilmPoster } from './FilmPoster';
import { filmTimeline } from './film/timeline';

type Props = {
  workspace: string; work: StoryboardWork; planId: string; preview: StoryboardDraftPreview; shot?: StoryboardShot; number?: number;
};

function details(shot: StoryboardShot, assets: StoryboardAsset[]): string[][] {
  const composition = shot.composition;
  const pointer = composition?.pointer;
  const box = composition?.callout;
  const percent = (n: number) => Number((n * 100).toFixed(2)) + '%';
  const camera = composition?.camera;
  const showAssets = (ids?: string[]) => ids?.map(id => assets.find(a => a.id === id)?.name ?? id).join('、') || '';
  return [
    ['镜头意图', shot.purpose], ['时长', shot.durationMs / 1000 + ' 秒'],
    ['画面标题', composition?.heading ?? ''],
    ['景别与构图', shot.framing], ['人物或物件', shot.subjects], ['场景', shot.setting],
    ['镜头动作', shot.motion], ['运镜', camera === 'push' ? '推近' : camera === 'pull' ? '拉远' : '固定'],
    ['转场', composition?.transition === 'dissolve' ? '叠化' : '切换'],
    ['指针', pointer ? `${pointer.atMs / 1000} 秒 · 横向 ${Math.round(pointer.x * 100)}% / 纵向 ${Math.round(pointer.y * 100)}%` : ''],
    ['画面标注', box ? [box.label, `${box.startMs / 1000}–${box.endMs / 1000} 秒`,
      `左 ${percent(box.x)}、上 ${percent(box.y)}，宽 ${percent(box.width)}、高 ${percent(box.height)}`].filter(Boolean).join(' · ') : ''],
    ['字幕', shot.captions.map(cue => `${cue.startMs / 1000}–${cue.endMs / 1000} 秒　${cue.text}`).join('\n')],
    ['声音设计', shot.sound], ['音量', Math.round((composition?.volume ?? 1) * 100) + '%'],
    ['素材', showAssets(shot.assetIds)], ['静音素材', showAssets(composition?.mutedAudioIds)],
  ];
}

export function StoryboardDraftReview({ workspace, work, planId, preview, shot, number }: Props) {
  const [index, setIndex] = useState(0);
  const { document: doc } = work;
  const film = useMemo(() => filmTimeline({ ...doc, shots: preview.shots }, planId), [doc, planId, preview.shots]);
  const selected = preview.shots[index];
  const scene = film.scenes[index];
  const original = doc.shots.filter(item => item.planId === planId);
  const dropped = new Set(original.filter(item => !preview.shots.some(next => next.id === item.id)).map(item => item.id));
  const removedClips = doc.tracks.reduce((n, track) => n + track.clips.filter(clip => dropped.has(clip.shotId)).length, 0);
  const prior = shot ? new Map(details(shot, doc.assets).map(([label, value]) => [label, value] as const)) : null;
  const rows = details(selected, doc.assets).filter(([label, value]) => prior ? value !== prior.get(label) : Boolean(value));
  const total = preview.shots.reduce((ms, s) => ms + s.durationMs, 0) / 1000;
  const sequence = (value: number) => String(value).padStart(2, '0');
  return <section className="story-draft-review" aria-label="分镜建议预览" tabIndex={-1}>
    <div className="story-draft-overview"><strong>{shot ? '本镜修改' : preview.shots.length + ' 个镜头'}</strong><span>{Number(total.toFixed(3))} 秒</span></div>
    {!shot && dropped.size > 0 && <p className="story-draft-impact">应用后将移除 {dropped.size} 个旧镜头{removedClips > 0 ? '及其中的 ' + removedClips + ' 段音轨' : ''}。</p>}
    <div className="story-draft-layout" data-sequence={preview.shots.length > 1}>
      {preview.shots.length > 1 && <nav aria-label="候选镜头" className="story-draft-sequence">
        {preview.shots.map((item, i) => <button type="button" key={item.id}
          aria-pressed={i === index} aria-label={`预览建议镜头 ${i + 1}`} onClick={() => setIndex(i)}>
          <span>{sequence(i + 1)}</span><strong>{item.purpose}</strong><small>{item.durationMs / 1000}s</small></button>)}
      </nav>}
      <div className="story-draft-inspect">
        {scene && <FilmPoster workspace={workspace} workId={work.id} scene={scene} title={doc.title}
          width={film.width} height={film.height} assets={doc.assets} />}
        <div className="story-draft-shot-title"><span>{sequence(number ?? index + 1)}</span><strong>{selected.purpose}</strong></div>
        {shot ? <>{rows.length ? <dl className="story-draft-fields">{rows.map(([label, value]) => <div key={label}>
            <dt>{label}</dt><dd><small>原来</small>{prior?.get(label) || '未设置'}</dd><dd><small>建议</small>{value || '清除'}</dd>
          </div>)}</dl> : <p className="story-draft-disclosure">建议与当前镜头相同。</p>}</>
          : <details className="story-draft-details" key={selected.id}><summary>查看镜头设计<ChevronDown aria-hidden /></summary>
            <dl className="story-draft-fields">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          </details>}
      </div>
    </div>
    <p className="story-draft-origin">制作 Skill · {preview.skillNames.map(name => name === 'storyboard-director' ? '分镜导演' : name).join('、')}<span>{preview.modelRef}</span></p>
  </section>;
}
