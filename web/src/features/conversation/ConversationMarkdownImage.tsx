import { useEffect, useState } from 'react';
import { safeMarkdownImageSource } from '../../shared/safe-url.ts';
import { ConversationImagePreview } from './ConversationImageGallery';

function workspaceImage(src: string) {
  if (!src) return '';
  try {
    const path = decodeURIComponent(src.split(/[?#]/, 1)[0]);
    const windowsDrive = /^[a-z]:[\\/]/i.test(path);
    if (/^[\\/]{2}/.test(path) || /[\u0000-\u001f]/.test(path) || (!windowsDrive && /^[a-z][a-z\d+.-]*:/i.test(path))) return '';
    return /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(path) ? path : '';
  } catch { return ''; }
}

export function ConversationMarkdownImage({ src, alt, cwd, linked }: { src: string; alt: string; cwd?: string; linked: boolean }) {
  const remote = safeMarkdownImageSource(src);
  const path = remote ? '' : workspaceImage(src);
  const [local, setLocal] = useState('');
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    if (!path || !cwd) return;
    let current = true;
    // The main process resolves symlinks, checks the workspace and bounds media size.
    window.piApi.filePreview(cwd, path).then(file => {
      if (!current) return;
      if (file.kind === 'image' && file.dataUrl) setLocal(file.dataUrl);
      else setFailed(true);
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [cwd, path]);

  const url = remote || local;
  if (failed || !url) return <span className="conversation-image-placeholder">{alt || path || '图片'}{failed ? '（无法预览）' : ''}</span>;
  const image = <img src={url} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  if (linked) return image;
  return <>
    <button className="conversation-markdown-image" type="button" aria-label={`放大预览：${alt || '图片'}`} onClick={() => setZoom(true)}>{image}</button>
    {zoom && <ConversationImagePreview images={[{ src: url, alt }]} index={0} onIndexChange={() => {}} onClose={() => setZoom(false)} />}
  </>;
}
