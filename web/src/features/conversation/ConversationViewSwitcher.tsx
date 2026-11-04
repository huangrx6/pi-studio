import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  Columns2,
  MessageSquare,
  Plug,
} from 'lucide-react';
import { PopoverSurface } from '../../shared/PopoverSurface';
import './conversation-view-switcher.css';

export type ConversationView = 'conversation' | 'agents' | 'comparison' | 'extensions';

export type ConversationViewOption = {
  kind: ConversationView;
  label: string;
  count?: number;
  live?: boolean;
};

const icons = {
  conversation: MessageSquare,
  agents: Bot,
  comparison: Columns2,
  extensions: Plug,
} satisfies Record<ConversationView, typeof MessageSquare>;

const tabbableSelector = [
  'button:not(:disabled)',
  'a[href]',
  'input:not(:disabled)',
  'textarea:not(:disabled)',
  'select:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function accessibleItemName(option: ConversationViewOption): string {
  if (!option.count) return option.label;
  if (option.kind === 'agents') {
    return `${option.label}，${option.count} 个${option.live ? '，正在运行' : ''}`;
  }
  if (option.kind === 'comparison') return `${option.label}，${option.count} 个分支`;
  return `${option.label}，${option.count} 项`;
}

/**
 * 会话内的视图切换器。
 *
 * 这里只负责“切换当前工作视图”，不承载创建动作。菜单项始终使用同一层级，
 * 避免把子智能体状态、双跑入口和扩展页面伪装成一组语义不同的 Tab。
 */
export function ConversationViewSwitcher({
  current,
  options,
  onSelect,
}: {
  current: ConversationView;
  options: ConversationViewOption[];
  onSelect: (view: ConversationView) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = options.find((option) => option.kind === current)
    ?? options.find((option) => option.kind === 'conversation')
    ?? { kind: 'conversation' as const, label: '对话' };
  const SelectedIcon = icons[selected.kind];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const active = menuRef.current?.querySelector<HTMLButtonElement>(
        '[role="menuitemradio"][aria-checked="true"]',
      );
      (active ?? menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  function closeAndFocusTrigger() {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }

  function choose(option: ConversationViewOption) {
    setOpen(false);
    onSelect(option.kind);
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    setOpen(true);
  }

  function moveMenuFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]',
    ) ?? [])];
    if (items.length === 0) return;
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex = activeIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = items.length - 1;
    else if (event.key === 'ArrowDown') nextIndex = (activeIndex + 1) % items.length;
    else if (event.key === 'ArrowUp') nextIndex = (activeIndex - 1 + items.length) % items.length;
    else return;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  /**
   * 菜单是原位弹层，但焦点在菜单内。Tab 关闭时手动把焦点送到触发器后面
   * （或前面）的下一个可交互元素，避免焦点落到已经卸载的菜单项上。
   */
  function leaveMenu(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const trigger = triggerRef.current;
    if (!trigger) return;
    const tabbables = [...document.querySelectorAll<HTMLElement>(tabbableSelector)].filter((element) => (
      element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== 'hidden'
    ));
    const triggerIndex = tabbables.indexOf(trigger);
    const direction = event.shiftKey ? -1 : 1;
    let nextIndex = triggerIndex + direction;
    while (
      nextIndex >= 0
      && nextIndex < tabbables.length
      && rootRef.current?.contains(tabbables[nextIndex])
    ) {
      nextIndex += direction;
    }
    const outside = tabbables.filter((element) => !rootRef.current?.contains(element));
    const target = tabbables[nextIndex] ?? (event.shiftKey ? outside.at(-1) : outside[0]) ?? trigger;
    setOpen(false);
    requestAnimationFrame(() => target?.focus({ preventScroll: true }));
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeAndFocusTrigger();
      return;
    }
    if (event.key === 'Tab') {
      leaveMenu(event);
      return;
    }
    moveMenuFocus(event);
  }

  return <div className="conversation-view-switcher" ref={rootRef}>
    <button
      ref={triggerRef}
      type="button"
      className={`conversation-view-switcher-trigger ${open ? 'is-open' : ''}`}
      aria-label={`切换会话视图，当前为${accessibleItemName(selected)}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      title="切换会话视图"
      onClick={() => setOpen((value) => !value)}
      onKeyDown={onTriggerKeyDown}
    >
      <SelectedIcon aria-hidden="true" />
      <span className="conversation-view-switcher-label">{selected.label}</span>
      {selected.count ? <span
        className={`conversation-view-switcher-count ${selected.live ? 'is-live' : ''}`}
        aria-hidden="true"
      >
        {selected.live && <i />}
        {selected.count}
      </span> : null}
      <ChevronDown className="conversation-view-switcher-chevron" aria-hidden="true" />
    </button>
    {open && <PopoverSurface
      ref={menuRef}
      id={menuId}
      className="conversation-view-menu"
      role="menu"
      aria-label="会话视图"
      onKeyDown={onMenuKeyDown}
    >
      {options.map((option) => {
        const Icon = icons[option.kind];
        const checked = option.kind === current;
        return <button
          key={option.kind}
          type="button"
          role="menuitemradio"
          aria-checked={checked}
          aria-label={accessibleItemName(option)}
          className={checked ? 'is-current' : ''}
          onClick={() => choose(option)}
        >
          <span className="conversation-view-menu-icon" aria-hidden="true"><Icon /></span>
          <span className="conversation-view-menu-label">{option.label}</span>
          {option.count ? <span
            className={`conversation-view-menu-count ${option.live ? 'is-live' : ''}`}
            aria-hidden="true"
          >
            {option.live && <i />}
            {option.count}
          </span> : <span className="conversation-view-menu-count is-empty" aria-hidden="true" />}
          <Check className="conversation-view-menu-check" aria-hidden="true" />
        </button>;
      })}
    </PopoverSurface>}
  </div>;
}
