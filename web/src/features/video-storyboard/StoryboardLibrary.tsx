import { useState } from 'react';
import { ArrowUpRight, ChevronDown, Clapperboard, FolderOpen, Plus } from 'lucide-react';
import { ActionMenu } from '../../shared/ActionMenu';
import { Select } from '../../shared/Select';
import type { StoryboardSummary } from '../../types/storyboard-types';
import exampleCover from '../../../../assets/storyboard/web-sources/studio.jpg';

type CreateWork = (example?: 'web-sources') => void;

export function StoryboardHeader({ works, currentId, busy, select, create }: {
  works: StoryboardSummary[]; currentId?: string; busy: boolean; select: (id: string) => void; create: CreateWork;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const bounds = anchor?.getBoundingClientRect();
  return <header className="story-toolbar">
    <div className="story-work-identity"><span className="story-work-icon"><Clapperboard aria-hidden /></span>
      <div><h2>视频分镜</h2>
        {works.length > 0 && <Select label="切换作品" className="story-selector" disabled={busy} value={currentId ?? ''}
          options={works.map(work => ({ value: work.id, label: work.title.trim() || '未命名作品' }))} onChange={select} />}
      </div>
    </div>
    {works.length > 0 && <button className="secondary-button story-create" aria-label="新建作品" aria-haspopup="menu"
      aria-expanded={Boolean(anchor)} disabled={busy} onClick={event => setAnchor(anchor ? null : event.currentTarget)}>
      <Plus aria-hidden />新建<ChevronDown aria-hidden />
    </button>}
    {anchor && bounds && <ActionMenu anchor={anchor} align="end" x={bounds.right} y={bounds.bottom + 4}
      onClose={() => setAnchor(null)} items={[
        { label: '空白作品', run: () => create() },
        { label: '从网页来源示例新建', run: () => create('web-sources') },
      ]} />}
  </header>;
}

export function StoryboardStart({ workspace, chooseWorkspace, create }: {
  workspace: string; chooseWorkspace: () => void; create: CreateWork;
}) {
  if (!workspace) return <section className="story-start story-start-workspace">
    <FolderOpen aria-hidden /><h3>选择作品所在的工作区</h3>
    <p>分镜草稿和素材清单会保存在所选工作区。</p>
    <button className="primary-button" onClick={chooseWorkspace}>选择工作区</button>
  </section>;
  return <section className="story-start" aria-label="开始视频创作">
    <div className="story-new-work">
      <h3>创建第一部作品</h3><p>从一句想法开始，也可以带上照片、视频或录音。</p>
      <button className="primary-button" onClick={() => create()}><Plus aria-hidden />新建作品</button>
    </div>
    <button className="story-example" onClick={() => create('web-sources')} aria-label="网页来源示例">
      <img src={exampleCover} alt="" />
      <span className="story-example-caption"><strong>网页来源示例</strong><small>4 个镜头 · 15 秒 · 中文旁白</small></span>
      <ArrowUpRight aria-hidden />
    </button>
  </section>;
}
