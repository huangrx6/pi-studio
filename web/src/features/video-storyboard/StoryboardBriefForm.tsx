import { Select } from '../../shared/Select';
import type { StoryboardBrief } from '../../types/storyboard-types';

const genres = [
  { value: 'free', label: '自由创作' }, { value: 'education', label: '知识讲解' },
  { value: 'wedding', label: '婚礼纪实' }, { value: 'product', label: '产品演示' },
];
const aspects = [
  { value: 'auto', label: '稍后决定' }, { value: '16:9', label: '横屏 16:9' },
  { value: '9:16', label: '竖屏 9:16' }, { value: '1:1', label: '方形 1:1' },
];

export function StoryboardBriefForm({ brief, question, edit, onBlur }: {
  brief: StoryboardBrief; question: string; edit: (patch: Partial<StoryboardBrief>) => void; onBlur: () => void;
}) {
  return <section className="story-brief" aria-label="创作想法" onBlur={onBlur}>
    <label className="story-field"><strong>{question}</strong>
      <textarea value={brief.idea} maxLength={16000}
        placeholder="写下想讲的故事、想留住的瞬间，或观众看完能学会什么…"
        onChange={event => edit({ idea: event.target.value })} /></label>
    <label className="story-field"><span>片名</span>
      <input value={brief.title} maxLength={120} placeholder="未命名作品" onChange={event => edit({ title: event.target.value })} /></label>
    <div className="story-options">
      <div className="story-field"><span>题材</span><Select label="题材" value={brief.genre} options={genres}
        onChange={genre => edit({ genre: genre as StoryboardBrief['genre'] })} /></div>
      <div className="story-field"><span>画幅</span><Select label="画幅" value={brief.aspect} options={aspects}
        onChange={aspect => edit({ aspect: aspect as StoryboardBrief['aspect'] })} /></div>
    </div>
  </section>;
}
