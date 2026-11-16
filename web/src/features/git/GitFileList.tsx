import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

const rowHeight = 46;
const overscan = 4;

export function GitFileList<T extends { path: string }>({ files, className, children }: {
  files: T[]; className: string; children: (file: T) => ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(320);
  const virtual = files.length > 64;
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el || !virtual) return;
    const measure = () => { setHeight(Math.min(el.clientHeight, window.innerHeight)); setTop(el.scrollTop); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [virtual, files.length]);
  if (!virtual) return <div className={className}>{files.map(children)}</div>;

  const count = Math.ceil(height / rowHeight) + overscan * 2 + 1;
  const start = Math.max(0, Math.min(files.length - count, Math.floor(top / rowHeight) - overscan));
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-file-index]');
    if (!row || event.altKey || event.metaKey || event.ctrlKey) return;
    const index = Number(row.dataset.fileIndex);
    const target = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: files.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const el = event.currentTarget;
    const next = Math.max(0, Math.min(files.length - 1, target));
    if (next * rowHeight < el.scrollTop) el.scrollTop = next * rowHeight;
    else if ((next + 1) * rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = (next + 1) * rowHeight - el.clientHeight;
    flushSync(() => setTop(el.scrollTop));
    el.querySelector<HTMLButtonElement>(`[data-file-index="${next}"] button`)?.focus({ preventScroll: true });
  }
  return <div className={className} ref={viewport} onScroll={e => setTop(e.currentTarget.scrollTop)} onKeyDown={navigate}>
    <div style={{ height: files.length * rowHeight, position: 'relative' }}>
      <div className="git-file-window" style={{ top: start * rowHeight }}>
        {files.slice(start, start + count).map((file, i) => <div key={file.path} data-file-index={start + i} style={{ height: rowHeight }}>
          {children(file)}
        </div>)}
      </div>
    </div>
  </div>;
}
