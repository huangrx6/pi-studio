import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export type SelectOption = { value: string; label: string; description?: string; disabled?: boolean };

type SelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
};

type Placement = { left: number; top?: number; bottom?: number; width: number };

/** Shared dropdown used by every form. Native selects render differently per OS. */
export function Select({ value, options, onChange, label, placeholder = '请选择', disabled = false, autoFocus = false, className = '' }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);

  useLayoutEffect(() => {
    if (!open) return;
    const update = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const roomBelow = window.innerHeight - rect.bottom - 10;
      const estimatedHeight = Math.min(260, Math.max(80, options.length * 34 + 8));
      const showAbove = roomBelow < estimatedHeight && rect.top > roomBelow;
      setPlacement({
        left: Math.min(rect.left, window.innerWidth - rect.width - 8),
        width: rect.width,
        ...(showAbove ? { bottom: window.innerHeight - rect.top + 5 } : { top: rect.bottom + 5 }),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const active = menuRef.current?.querySelector<HTMLButtonElement>('[data-selected="true"]');
      (active ?? menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  function choose(next: SelectOption): void {
    if (next.disabled) return;
    onChange(next.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
    items[next]?.focus();
  }

  const portalTarget = triggerRef.current?.closest('dialog') ?? document.body;

  return (
    <div className={`pi-select ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`pi-select-trigger ${open ? 'is-open' : ''}`}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={selected ? 'pi-select-value' : 'pi-select-placeholder'}>{selected?.label ?? placeholder}</span>
        <ChevronDown className="pi-select-chevron" />
      </button>
      {open && placement && createPortal(
        <div
          ref={menuRef}
          id={listId}
          className="pi-select-menu"
          role="listbox"
          aria-label={label}
          style={{ left: placement.left, width: placement.width, top: placement.top, bottom: placement.bottom }}
          onKeyDown={onMenuKeyDown}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              data-selected={option.value === value}
              className={`pi-select-option ${option.value === value ? 'is-selected' : ''}`}
              disabled={option.disabled}
              onClick={() => choose(option)}
            >
              <span>
                <span className="pi-select-option-label">{option.label}</span>
                {option.description && <small>{option.description}</small>}
              </span>
              {option.value === value && <Check />}
            </button>
          ))}
        </div>,
        portalTarget,
      )}
    </div>
  );
}
