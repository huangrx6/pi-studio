import { useState } from 'react';
import { Eye, FileText, FileVideo, Image, Music2, Plus, Upload, X } from 'lucide-react';
import type { StoryboardDirection, StoryboardWork } from '../../types/storyboard-types';
import { formatFileSize } from '../../shared/filesize';
import { errorText } from '../../shared/error-text';
import { SourcePreview } from './SourcePreview';

const icons = { image: Image, audio: Music2, video: FileVideo, document: FileText };
const labels = { image: '图片', audio: '音频', video: '视频', document: '文稿' };

export function StoryboardMaterials({ workspace, work, onWork, selection, disabled = false, onChanging }: {
  workspace: string; work: StoryboardWork; onWork: (work: StoryboardWork) => void;
  disabled?: boolean;
  onChanging?: (changing: boolean) => void;
  selection?: { need: NonNullable<StoryboardDirection['need']>; ids: string[]; toggle: (id: string) => void };
}) {
  const assets = selection ? work.document.assets.filter(asset => selection.need.kinds.includes(asset.kind)) : work.document.assets;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [previewId, setPreviewId] = useState('');
  const preview = assets.find(asset => asset.id === previewId);
  async function change(operation: () => Promise<StoryboardWork>) {
    if (busy || disabled) return;
    setBusy(true);
    onChanging?.(true);
    setError('');
    try { onWork(await operation()); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); onChanging?.(false); }
  }
  const pick = () => void change(() => window.piApi.storyboardPick(workspace, work.id));
  return <section className={`story-materials${dragging ? ' is-dragging' : ''}`} aria-label="作品素材" aria-busy={busy}
    onDragOver={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = busy || disabled ? 'none' : 'copy';
      setDragging(!busy && !disabled);
    }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      setDragging(false);
      const files = Array.from(event.dataTransfer.files);
      if (files.length) void change(() => window.piApi.storyboardDrop(workspace, work.id, files));
    }}>
    <header className="story-section-head"><h3>{selection ? selection.need.label : '素材'} <span>{selection ? `${selection.ids.length} / ${selection.need.count}` : assets.length}</span></h3>
      {assets.length > 0 && <button className="icon-button" aria-label="添加素材" title="添加素材" onClick={pick} disabled={busy}><Plus /></button>}
    </header>
    {assets.length ? <ul className="story-assets">
      {assets.map(asset => {
        const Icon = icons[asset.kind];
        const inspect = () => setPreviewId(current => current === asset.id ? '' : asset.id);
        const name = <span className="story-asset-name"><strong title={asset.name}>{asset.name}</strong><small>{labels[asset.kind]} · {formatFileSize(asset.size)}</small></span>;
        if (selection) return <li className="story-asset-choice" key={asset.id}>
          <label><input type={selection.need.count === 1 ? 'radio' : 'checkbox'} name="story-asset-choice"
            disabled={selection.need.count > 1 && !selection.ids.includes(asset.id) && selection.ids.length >= selection.need.count}
            checked={selection.ids.includes(asset.id)} onChange={() => selection.toggle(asset.id)} />
            {name}</label>
          <button className="icon-button" aria-label={`预览 ${asset.name}`} title="预览素材" aria-pressed={preview?.id === asset.id} onClick={inspect}><Eye /></button>
        </li>;
        return <li key={asset.id}><button className="story-inspect-asset" aria-label={`预览 ${asset.name}`} title="预览素材"
          aria-expanded={preview?.id === asset.id} onClick={inspect}>
          <Icon aria-hidden />{name}<Eye aria-hidden /></button>
          <button className="icon-button" title="从作品移除" aria-label={`移除 ${asset.name}`} disabled={busy}
            onClick={() => void change(() => window.piApi.storyboardRemoveFile(workspace, work.id, asset.id))}><X /></button>
        </li>;
      })}
    </ul> : <button className="story-dropzone" disabled={busy} onClick={pick}>
      <Upload aria-hidden /><span><strong>{busy ? '正在添加素材…' : '选择或拖入素材'}</strong><small>{selection ? selection.need.kinds.map(kind => labels[kind]).join('或') : '图片、视频、音频或文稿'}</small></span>
    </button>}
    {preview && <SourcePreview key={preview.id} asset={preview} workspace={workspace} workId={work.id} onWork={onWork} />}
    {!selection && <p className="story-note">引用本机原文件，可稍后添加。</p>}
    {error && <p className="story-error" role="alert">{error}</p>}
  </section>;
}
