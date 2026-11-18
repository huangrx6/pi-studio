import { Accordion } from '../../shared/Accordion';
import { SlidersHorizontal } from 'lucide-react';
import type { ShotPatch, StoryboardShot } from '../../types/storyboard-types';
import { Select } from '../../shared/Select';

export function ShotComposition({ shot, edit }: { shot: StoryboardShot; edit: (patch: ShotPatch) => void }) {
  const config = shot.composition ?? {};
  const volume = Math.round((config.volume ?? 1) * 100);
  const captions = shot.captions.length ? shot.captions : [{ startMs: 0, endMs: shot.durationMs, text: '' }];
  return <>
    {captions.map((cue, i) => {
      const label = captions.length > 1 ? `字幕 ${i + 1}` : '字幕';
      return <label className="story-field story-caption-field" key={i}>
        <span>{label}{shot.captions.length > 0 && <small>{cue.startMs / 1000} – {cue.endMs / 1000} 秒</small>}</span>
        <textarea aria-label={label} rows={2} maxLength={2000} value={cue.text} placeholder="输入这一镜的字幕" onChange={event => {
          const text = event.target.value;
          edit({ captions: captions.map((c, j) => j === i ? { ...c, text } : c) });
        }} />
      </label>;
    })}
    <Accordion className="story-shot-disclosure" summary={<><SlidersHorizontal aria-hidden /><span>成片设置</span></>}>
      <div className="story-composition-fields">
        <label className="story-field story-composition-title"><span>画面标题（选填）</span><input maxLength={200} value={config.heading ?? ''}
          onChange={event => edit({ composition: { ...config, heading: event.target.value } })} /></label>
        <div className="story-field"><span>镜头运动</span><Select label="镜头运动" value={config.camera ?? 'still'}
          options={[{ value: 'still', label: '固定' }, { value: 'push', label: '缓慢推进' }, { value: 'pull', label: '缓慢拉远' }]}
          onChange={value => edit({ composition: { ...config, camera: value as 'still' | 'push' | 'pull' } })} /></div>
        <div className="story-field"><span>入镜转场</span><Select label="入镜转场" value={config.transition ?? 'cut'}
          options={[{ value: 'cut', label: '直接切换' }, { value: 'dissolve', label: '叠化' }]}
          onChange={value => edit({ composition: { ...config, transition: value as 'cut' | 'dissolve' } })} /></div>
        <label className="story-volume-field"><span>本镜音量</span><input aria-label="本镜音量" aria-valuetext={`${volume}%`} type="range" min="0" max="100" value={volume}
          onChange={event => edit({ composition: { ...config, volume: Number(event.target.value) / 100 } })} /><small>{volume}%</small></label>
      </div>
    </Accordion>
  </>;
}
