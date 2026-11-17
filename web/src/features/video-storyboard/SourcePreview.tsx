import { useEffect, useState } from 'react';
import { FileText, ImageOff, LocateFixed } from 'lucide-react';
import type { AssetPreview, StoryboardAsset, StoryboardWork } from '../../types/storyboard-types';
import { formatFileSize } from '../../shared/filesize';
import { errorText } from '../../shared/error-text';
import { loadStoryboardAssetPreview } from './storyboard-asset-preview';

export function SourcePreview({ workspace, workId, asset, onWork }: {
  workspace: string; workId: string; asset: StoryboardAsset; onWork: (work: StoryboardWork) => void;
}) {
  const [data, setData] = useState<AssetPreview | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState('');
  const [metadata, setMetadata] = useState('');
  const [busy, setBusy] = useState(false);
  const { id, kind, name, size } = asset;
  useEffect(() => {
    let active = true;
    setError(''); setData(null); setFailed(false); setMetadata('');
    loadStoryboardAssetPreview(workspace, workId, { id, kind, name, size }).then(result => { if (active) setData(result); })
      .catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [workspace, workId, id, kind, name, size, refresh]);
  async function relink() {
    setBusy(true);
    try { onWork(await window.piApi.storyboardRelink(workspace, workId, asset.id)); setRefresh(value => value + 1); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  function mediaMetadata(el: HTMLMediaElement) {
    const duration = Number.isFinite(el.duration) ? `${Number(el.duration.toFixed(1))} 秒` : '';
    const size = el instanceof HTMLVideoElement && el.videoWidth ? `${el.videoWidth} × ${el.videoHeight}` : '';
    setMetadata([size, duration].filter(Boolean).join(' · '));
  }
  return <figure className="story-source-preview" aria-label={`素材预览 · ${asset.name}`}>
    <figcaption><span><strong>{asset.name}</strong><small>{[formatFileSize(data?.size ?? asset.size), metadata, failed && '原文件无法在此播放'].filter(Boolean).join(' · ')}</small></span>
      <button className={data?.missing ? 'secondary-button' : 'icon-button'} type="button" title="重新定位源文件" aria-label={`重新定位 ${asset.name}`}
        onClick={relink} disabled={busy}><LocateFixed />{data?.missing && '重新定位'}</button></figcaption>
    {data?.missing ? <p><ImageOff />找不到原文件</p>
      : !data ? <p>{error || '正在读取素材…'}</p>
      : !failed && data.url && asset.kind === 'video' ? <video src={data.url + '#t=0.001'} controls preload="metadata"
          onLoadedMetadata={event => mediaMetadata(event.currentTarget)} onError={() => setFailed(true)} />
      : !failed && data.url && asset.kind === 'audio' ? <audio src={data.url} controls preload="metadata"
          onLoadedMetadata={event => mediaMetadata(event.currentTarget)} onError={() => setFailed(true)} />
      : !failed && data.url && asset.kind === 'image' ? <img src={data.url} alt={asset.name}
          onLoad={event => setMetadata(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} onError={() => setFailed(true)} />
      : data.text !== undefined ? <pre>{data.text || '空文稿'}</pre>
      : data.thumbnail ? <img src={data.thumbnail} alt={asset.name + '缩略图'} />
      : <p><FileText />当前格式暂无预览</p>}
    {error && data && <p className="story-error" role="alert">{error}</p>}
  </figure>;
}
