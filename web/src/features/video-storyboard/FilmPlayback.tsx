import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import { Maximize, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { errorText } from '../../shared/error-text';
import { fps } from './film/timeline';

export function movieTime(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}

export function FilmPlayback({ video, url, portrait, initialTime, onTime, onScrub, onError }: {
  video: RefObject<HTMLVideoElement>; url: string; portrait: boolean; initialTime: number;
  onTime: (seconds: number) => void; onScrub: (seconds: number) => void; onError: (message: string) => void;
}) {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    const player = video.current;
    if (!player) return;
    const fullscreenChanged = () => { player.controls = document.fullscreenElement === player; };
    document.addEventListener('fullscreenchange', fullscreenChanged);
    return () => document.removeEventListener('fullscreenchange', fullscreenChanged);
  }, [video]);
  function togglePlayback() {
    const player = video.current;
    if (!player) return;
    if (player.paused) void player.play().catch(err => onError(errorText(err)));
    else player.pause();
  }
  const playLabel = playing ? '暂停成片' : '播放成片';
  return <>
    <div className="story-film-stage" data-portrait={portrait}>
      <video ref={video} src={url} preload="auto" aria-label="分镜成片"
        onLoadedMetadata={event => {
          const player = event.currentTarget;
          setDuration(player.duration);
          player.currentTime = initialTime;
        }}
        onTimeUpdate={event => {
          const seconds = event.currentTarget.currentTime;
          setTime(seconds); onTime(seconds);
        }}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onVolumeChange={e => setMuted(e.currentTarget.muted)}
        onError={() => onError('无法播放编码结果，请重新生成预览')} />
    </div>
    <div className="story-monitor-transport">
      <button className="icon-button" disabled={!duration} aria-label={playLabel} title={playLabel} onClick={togglePlayback}>
        {playing ? <Pause /> : <Play />}</button>
      <small className="story-monitor-time">{movieTime(time)} <span>/ {movieTime(duration)}</span></small>
      <input type="range" aria-label="成片播放位置" aria-valuetext={movieTime(time)} min="0" max={duration}
        style={{ '--range-progress': (duration ? time / duration * 100 : 0) + '%' } as CSSProperties}
        step={1 / fps} disabled={!duration} value={time} onChange={event => {
          const player = video.current;
          if (!player) return;
          const seconds = Number(event.target.value);
          player.currentTime = seconds; setTime(seconds); onScrub(seconds);
        }} />
      <button className="icon-button" aria-label={muted ? '开启成片声音' : '成片静音'} title={muted ? '开启成片声音' : '成片静音'}
        onClick={() => { if (video.current) video.current.muted = !muted; }}>{muted ? <VolumeX /> : <Volume2 />}</button>
      <button className="icon-button" aria-label="全屏播放成片" title="全屏播放成片"
        onClick={() => void video.current?.requestFullscreen().catch(err => onError(errorText(err)))}><Maximize /></button>
    </div>
  </>;
}
