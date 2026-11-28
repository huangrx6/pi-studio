import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import { Check, ChevronRight, Palette } from 'lucide-react';
import { presets } from './appearance';
import { label } from './bridge';

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'type'> & { label: string };
export function IconButton({ label, className = '', children, ...props }: IconButtonProps) {
  return <button type="button" className={'icon-button ' + className} aria-label={label} data-tooltip={label} {...props}>
    {children}
  </button>;
}

export function Breadcrumb({ path }: { path: string }) {
  const pieces = path ? path.split('/') : [];
  const text = pieces.map((part, index) => index === pieces.length - 1 ? label(part) : part);
  const trackRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const foldRef = useRef<HTMLDetailsElement>(null);
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const measure = measureRef.current;
    if (!track || !measure) return;
    const update = () => setCompact(measure.offsetWidth > track.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(track);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [path]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (foldRef.current?.open && !foldRef.current.contains(event.target as Node)) foldRef.current.open = false;
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  const ordinary = text.map((part, index) => <span key={index} className="breadcrumb-part">
    {index > 0 && <ChevronRight size="calc(var(--icon-xs) + 1px)" aria-hidden="true" />}
    <span>{part}</span>
  </span>);

  if (!pieces.length) return <strong className="breadcrumb-empty">知识库</strong>;
  return <div className="breadcrumb-track" ref={trackRef} title={pieces.join(' / ')} data-compact={compact}>
    <div className="breadcrumb-measure" ref={measureRef} aria-hidden="true">{ordinary}</div>
    <nav className="breadcrumb-visible" aria-label="当前文件路径">
      {compact ? <>
        {pieces.length > 2 && ordinary[0]}
        <span className="breadcrumb-part breadcrumb-fold">
          {pieces.length > 2 && <ChevronRight size="calc(var(--icon-xs) + 1px)" aria-hidden="true" />}
          <details ref={foldRef} key={path} onKeyDown={event => {
            if (event.key === 'Escape' && event.currentTarget.open) {
              event.stopPropagation();
              event.currentTarget.open = false;
              event.currentTarget.querySelector('summary')?.focus();
            }
          }}>
            <summary aria-label="查看完整路径" title="查看完整路径">…</summary>
            <ol aria-label="完整路径">
              {pieces.map((part, index) => <li key={index}>
                {index > 0 && <ChevronRight size="var(--icon-xs)" aria-hidden="true" />}<span>{part}</span>
              </li>)}
            </ol>
          </details>
        </span>
        {ordinary[ordinary.length - 1]}
      </> : ordinary}
    </nav>
  </div>;
}

export function SaveStatus({ state, label }: { state: 'saved' | 'dirty' | 'conflict' | 'saving'; label: string }) {
  return <span className="save-status" role="status" tabIndex={0} data-state={state} data-tooltip={label}>
    <span className="sr-only">{label}</span><span className="save-dot" aria-hidden="true" />
  </span>;
}

export function ThemeMenu({ selected, onChange }: { selected: string; onChange: (theme: string) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      ref.current?.querySelector('button')?.focus();
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const follow = presets.filter(theme => !theme.scheme);
  const darkThemes = presets.filter(theme => theme.scheme === 'dark');
  const lightThemes = presets.filter(theme => theme.scheme === 'light');

  function option(theme: typeof presets[number]) {
    return <button key={theme.id} type="button" aria-pressed={selected === theme.id} onClick={() => {
      onChange(theme.id);
      setOpen(false);
      ref.current?.querySelector('button')?.focus();
    }}>
      <span className="theme-swatch" aria-hidden="true" style={theme.scheme
        ? { background: theme.bg, color: theme.accent, borderColor: 'color-mix(in srgb, ' + theme.text + ' 20%, transparent)', ['--swatch-surface' as string]: theme.surface }
        : undefined} />
      <span className="theme-title">{theme.title}</span>
      {selected === theme.id && <Check size="calc(var(--icon-xs) + 1px)" aria-hidden="true" />}
    </button>;
  }

  return <div className="toolbar-menu" ref={ref}>
    <IconButton label="知识库主题" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
      <Palette size="var(--icon-md)" />
    </IconButton>
    {open && <div id={id} className="theme-menu" role="group" aria-label="选择知识库主题">
      {follow.map(option)}
      {darkThemes.length > 0 && <>
        <div className="theme-group" role="presentation">深色</div>
        {darkThemes.map(option)}
      </>}
      {lightThemes.length > 0 && <>
        <div className="theme-group" role="presentation">浅色</div>
        {lightThemes.map(option)}
      </>}
    </div>}
  </div>;
}
