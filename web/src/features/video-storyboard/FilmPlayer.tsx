import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, MonitorPlay, Play, RefreshCw } from 'lucide-react';
import type { StoryboardWork } from '../../types/storyboard-types';
import { errorText } from '../../shared/error-text';
import { settleStoryboardDrafts } from './storyboard-drafts';
import { filmTimeline, fps, type Scene } from './film/timeline';
import { FilmPlayback, movieTime } from './FilmPlayback';
import { FilmPoster } from './FilmPoster';
import './styles/film-player.css';

type Preview = { id: string; url: string; revision: number };

function cutTime(frame: number) {
  const tenths = Math.round(frame * 10 / fps);
  return movieTime(tenths / 10) + (tenths % 10 ? '.' + tenths % 10 : '');
}

export function FilmPlayer({ work, workspace, planId, selectedId, select }: {
  work: StoryboardWork; workspace: string; planId: string; selectedId?: string; select: (id: string) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [playhead, setPlayhead] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const kept = useRef<Preview | null>(null);
  const task = useRef<AbortController | null>(null);
  const scrubSelection = useRef('');
  const film = useMemo(() => filmTimeline(work.document, planId), [work.document, planId]);
  const scene = film.scenes.find(item => item.shot.id === selectedId) ?? film.scenes[0];
  const stale = Boolean(preview && preview.revision !== (work.document.renderRevision ?? work.revision));
  const playable = stale ? null : preview;
  const start = scene ? scene.first / fps : 0;

  useEffect(() => () => {
    task.current?.abort();
    if (kept.current) void window.piApi.storyboardRenderDiscard(workspace, work.id, kept.current.id).catch(() => {});
  }, [workspace, work.id, planId]);

  useEffect(() => {
    const player = video.current;
    // Scrubbing selects the editor, but the playhead stays on the exact frame the user picked.
    const cameFromScrub = scrubSelection.current === selectedId;
    scrubSelection.current = '';
    if (!cameFromScrub && player && player.readyState > 0) {
      player.pause(); player.currentTime = start;
    }
  }, [selectedId, start, playable?.id]);

  function sceneAt(seconds: number) {
    const frame = Math.floor(seconds * fps + 1e-7);
    return film.scenes.find(item => frame < item.first + item.frames) ?? film.scenes.at(-1);
  }
  function jump(item: Scene) {
    scrubSelection.current = '';
    select(item.shot.id);
    if (video.current && playable && video.current.readyState > 0) {
      video.current.pause(); video.current.currentTime = item.first / fps;
    }
  }
  async function run(exportFile: boolean, regenerate = false) {
    if (task.current) return;
    const controller = new AbortController();
    task.current = controller;
    setNotice(''); setError('');
    if (exportFile) setSaving(true);
    else setProgress(0);
    try {
      await settleStoryboardDrafts(workspace, work.id);
      const snapshot = await window.piApi.storyboardRead(workspace, work.id);
      controller.signal.throwIfAborted();
      let result = kept.current;
      if (regenerate || !result || result.revision !== (snapshot.document.renderRevision ?? snapshot.revision)) {
        setProgress(0);
        const { renderFilm } = await import('./film/render');
        const next = await renderFilm(workspace, snapshot, planId, controller.signal, setProgress);
        if (controller.signal.aborted) { await window.piApi.storyboardRenderDiscard(workspace, work.id, next.id); return; }
        kept.current = next; setPreview(next); setPlayhead('');
        if (result) await window.piApi.storyboardRenderDiscard(workspace, work.id, result.id);
        result = next;
      }
      setProgress(null);
      if (exportFile && !controller.signal.aborted) {
        const name = await window.piApi.storyboardRenderSave(workspace, work.id, result.id);
        if (name) setNotice('已导出 ' + name);
      }
    } catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)); }
    finally { task.current = null; setProgress(null); setSaving(false); }
  }
  return <section className="story-film story-monitor" aria-label="整片预览">
    <header className="story-monitor-heading"><h3><MonitorPlay aria-hidden />整片预览
      {!playable && <span className="story-monitor-mode">分镜静帧</span>}</h3>
      <small>{film.width} × {film.height} · {fps} fps</small></header>
    {playable ? <FilmPlayback key={playable.id} video={video} url={playable.url} portrait={film.height > film.width} initialTime={start}
      onError={setError} onTime={seconds => setPlayhead(sceneAt(seconds)?.shot.id ?? '')}
      onScrub={seconds => {
        const next = sceneAt(seconds);
        if (next && next.shot.id !== selectedId) {
          scrubSelection.current = next.shot.id;
          select(next.shot.id);
        }
      }} />
      : scene && <FilmPoster key={scene.shot.id} workspace={workspace} workId={work.id} title={work.document.title}
        width={film.width} height={film.height} scene={scene} assets={work.document.assets} />}
    <div className="story-film-cuts">
      <div className="story-film-cut-heading"><strong>镜头时间线</strong><small>{film.scenes.length} 镜 · {cutTime(film.frames)}</small></div>
      <nav aria-label="成片时间线">{film.scenes.map((item, i) =>
        <button key={item.shot.id} style={{ flexGrow: item.frames }} title={cutTime(item.first) + ' · ' + item.shot.purpose}
          aria-label={`跳到第 ${i + 1} 镜`} aria-pressed={item.shot.id === scene?.shot.id}
          aria-current={playable && item.shot.id === playhead ? 'time' : undefined} onClick={() => jump(item)}>
          <b>{String(i + 1).padStart(2, '0')}</b><span>{item.shot.purpose || '未命名镜头'}</span>
        </button>)}</nav>
    </div>
    <footer className="story-monitor-footer">
      {progress !== null ? <div className="story-monitor-progress">
        <label>正在合成 <span>{progress}%</span><progress value={progress} max={100} aria-label="合成进度" /></label>
        <button className="secondary-button" onClick={() => task.current?.abort()}>取消合成</button></div>
        : <><button className={playable ? 'story-monitor-refresh' : 'primary-button'} disabled={saving || !scene}
          aria-label={stale ? '更新预览' : preview ? '重新生成预览' : '生成整片预览'}
          onClick={() => void run(false, Boolean(preview))}>
          {preview ? <RefreshCw /> : <Play />}{stale ? '更新预览' : preview ? '重新合成' : '生成整片预览'}</button>
          <button className={playable ? 'primary-button' : 'secondary-button'} disabled={saving || !scene} onClick={() => void run(true)}>
            <Download />{saving ? '正在导出…' : '导出 MP4'}</button></>}
    </footer>
    {stale && progress === null && !error && <small className="story-monitor-note" role="status">分镜已修改，更新预览后可播放。</small>}
    {error && <p className="story-error" role="alert">{error}</p>}
    {notice && !stale && <small className="story-monitor-note" role="status"><Check aria-hidden />{notice}</small>}
  </section>;
}
