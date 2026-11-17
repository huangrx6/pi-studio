import { useEffect, useState } from 'react';
import { DeferredFilePreview } from '../../shared/DeferredFilePreview';
import { errorText } from '../../shared/error-text';
import type { TurnDiffFile } from '../../types/chat-types';
import type { FilePreviewResult } from '../../types/file-preview-types';
import './styles/turn-file-preview.css';

type Props = { sessionId: string; at: number; file: TurnDiffFile };

export function TurnFilePreview({ sessionId, at, file }: Props) {
  const [before, setBefore] = useState(false);
  const [retry, setRetry] = useState(0);
  const side = file.status === 'deleted' || (before && file.status !== 'added') ? 'before' : 'after';
  const { path } = file;
  const key = JSON.stringify([sessionId, at, path, side]);
  const [result, setResult] = useState<{ key: string; file?: FilePreviewResult; error?: string }>();
  useEffect(() => {
    let active = true;
    window.piApi.turnFilePreview({ sessionId, at, path, side }).then(
      file => { if (active) setResult({ key, file }); },
      cause => { if (active) setResult({ key, error: errorText(cause) }); },
    );
    return () => { active = false; };
  }, [sessionId, at, path, side, key, retry]);
  const current = result?.key === key ? result : undefined;
  return <section className="turn-file-preview" aria-label="轮次文件预览">
    {file.status === 'modified' && <div className="turn-file-versions" role="group" aria-label="轮次文件版本">
      <button type="button" aria-pressed={before} onClick={() => setBefore(true)}>本轮变更前</button>
      <button type="button" aria-pressed={!before} onClick={() => setBefore(false)}>本轮变更后</button>
    </div>}
    {current?.error ? <p role="alert">{current.error} <button className="text-button" onClick={() => { setResult(undefined); setRetry(value => value + 1); }}>重试</button></p>
      : <DeferredFilePreview file={current?.file || null} loading={!current?.file} />}
  </section>;
}
