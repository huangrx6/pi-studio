import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Search, type LucideIcon } from 'lucide-react';
import { HintButton } from '../../shared/HintButton';
import { PopoverSurface } from '../../shared/PopoverSurface';
import { isComposingKey, menuFocusIndex } from '../../shared/keyboard-navigation';
import { errorText } from '../../shared/error-text';
import { useGitRevision } from './useGitTools';
import './styles/git-branch.css';

export function useGitPickerData<T>(cwd: string, repository: string, read: (cwd: string, repository: string) => Promise<T>) {
  const revision = useGitRevision();
  const [result, setResult] = useState<{ revision: number; data?: T; error?: string }>();
  useEffect(() => {
    let active = true;
    read(cwd, repository).then(data => {
      if (active) setResult({ revision, data });
    }, cause => {
      if (active) setResult({ revision, error: errorText(cause) });
    });
    return () => { active = false; };
  }, [cwd, repository, read, revision]);
  return { data: result?.data, error: result?.error, loading: result?.revision !== revision };
}

export function GitContextPicker({ label, value, title, icon: Icon, iconOnly = false, placeholder, children }: {
  label: string; value: string; title: string; icon: LucideIcon; iconOnly?: boolean; placeholder: string;
  children: (query: string, close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    if (!open) return;
    const align = () => {
      if (!anchor.current || !menu.current) return;
      const bounds = anchor.current.getBoundingClientRect();
      menu.current.style.left = Math.max(8, Math.min(bounds.left, innerWidth - 8 - menu.current.offsetWidth)) + 'px';
      menu.current.style.bottom = innerHeight - bounds.top + 6 + 'px';
    };
    align();
    window.addEventListener('resize', align);
    return () => window.removeEventListener('resize', align);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => { if (!anchor.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
  }, [open]);
  return <div className="git-context-picker" ref={anchor} onKeyDown={event => {
    if (isComposingKey(event.nativeEvent)) return;
    if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (!open) { setQuery(''); setOpen(true); return; }
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
    const next = menuFocusIndex(event.key, buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length, true);
    if (next !== null) buttons[next].focus();
  }}>
    <HintButton ref={trigger} className="git-context-trigger" aria-label={label + '，当前 ' + value}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined} hint={title} placement="above"
      onClick={() => { setQuery(''); setOpen(!open); }}>
      <Icon aria-hidden="true" />{!iconOnly && <span>{value}</span>}
    </HintButton>
    {open && <PopoverSurface topLayer ref={menu} id={menuId} className="git-branch-menu" role="dialog" aria-label={label}>
      <label className="git-branch-search"><Search aria-hidden="true" /><input autoFocus placeholder={placeholder} aria-label={placeholder}
        value={query} onChange={event => setQuery(event.target.value)} /></label>
      {children(query.trim(), close)}
    </PopoverSurface>}
  </div>;
}
