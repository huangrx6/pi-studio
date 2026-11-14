/**
 * 统一的自定义下拉选择器，替换原生 <select>（原生控件在各系统外观差异大）。
 *
 * 关键实现：
 * - 菜单通过 createPortal 渲染到最近的 dialog 或模态遮罩层（没有则 body），
 *   避免被 overflow 容器裁剪，同时保持在弹窗内容与遮罩之上；
 * - 用 useLayoutEffect 在 paint 前计算 fixed 坐标，空间不足时向上展开；
 * - 支持点击外部关闭、Esc 关闭并归还焦点、上下键/Home/End 在选项间移动；
 * - 自定义组件需要手动补齐 listbox / option 的 aria 关系。
 *
 * 纯 UI 组件，不涉及 IPC。选项禁用时不可选，但当前值仍会显示。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { PopoverSurface } from './PopoverSurface';
import { isComposingKey, menuFocusIndex } from './keyboard-navigation';

/** 一个选项；description 作为次要说明展示在标签下方，也参与视觉分组。 */
export type SelectOption = { value: string; label: string; description?: string; disabled?: boolean };

/** Select 的受控 props。 */
type SelectProps = {
  /** 当前选中值；找不到对应选项时显示 placeholder。 */
  value: string;
  /** 可选项列表。 */
  options: SelectOption[];
  /** 选择回调；点击已选项也会触发一次。 */
  onChange: (value: string) => void;
  /** 可访问名称（aria-label）；不是可见标题。 */
  label?: string;
  /** 无匹配选项时的占位文案。 */
  placeholder?: string;
  /** 禁用整个控件。 */
  disabled?: boolean;
  /** 挂载后自动聚焦触发按钮。 */
  autoFocus?: boolean;
  /** 追加到外层容器的 class。 */
  className?: string;
  /** 追加到弹出菜单的 class（用于宽度/样式微调）。 */
  menuClassName?: string;
  /** 触发器前置图标；与文字同属一个点击区域。 */
  leadingIcon?: ReactNode;
};

const MENU_EDGE_INSET = 12;
const MENU_GAP = 5;

/**
 * 下拉选择器。
 *
 * @param value 受控值
 * @param options 选项
 * @param onChange 选中回调
 * @param label aria-label，用于触发按钮与 listbox
 * @param placeholder 未选中时的占位
 * @param disabled 禁用
 * @param autoFocus 自动聚焦触发按钮
 * @param className / menuClassName 额外的容器/菜单 class
 *
 * 按菜单实际高度选择展开方向，并在弹出方向的可用空间内滚动。
 */
export function Select({ value, options, onChange, label, placeholder = '请选择', disabled = false, autoFocus = false, className = '', menuClassName = '', leadingIcon }: SelectProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);

  // 先按最终宽度排版，再测量含换行说明的菜单。Portal 使用视口坐标，
  // 但会话内的菜单应与圆角内容区一起收口。
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!open || !trigger || !menu) return;
    const pane = trigger.closest('main');
    const update = (): void => {
      const rect = trigger.getBoundingClientRect();
      const paneRect = pane?.getBoundingClientRect();
      const topBound = Math.max(0, paneRect?.top ?? 0) + MENU_EDGE_INSET;
      const bottomBound = Math.min(window.innerHeight, paneRect?.bottom ?? window.innerHeight) - MENU_EDGE_INSET;
      const roomBelow = Math.max(0, bottomBound - rect.bottom - MENU_GAP);
      const roomAbove = Math.max(0, rect.top - MENU_GAP - topBound);
      const hasDescriptions = options.some(option => option.description);
      const width = Math.min(window.innerWidth - 16, Math.max(rect.width, hasDescriptions ? 288 : 160));
      menu.style.width = `${width}px`;
      menu.style.removeProperty('max-height');
      const box = menu.getBoundingClientRect();
      const showAbove = box.height > roomBelow && roomAbove > roomBelow;
      const room = showAbove ? roomAbove : roomBelow;
      if (box.height > room) menu.style.maxHeight = `${room}px`;
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))}px`;
      menu.style.top = showAbove ? 'auto' : `${rect.bottom + MENU_GAP}px`;
      menu.style.bottom = showAbove ? `${window.innerHeight - rect.top + MENU_GAP}px` : 'auto';
    };
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node && menu.contains(event.target))) update();
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(trigger);
    if (pane) observer.observe(pane);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, options]);

  // 点击菜单与触发按钮之外的地方关闭；用 pointerdown 能覆盖鼠标、触控与手写笔。
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

  // Chromium 的原生 <dialog> 会在 keydown 后继续派发 cancel。只在菜单打开时于
  // document 捕获阶段截断 Escape，确保第一下只关闭下拉，不会连带关闭设置弹窗。
  useEffect(() => {
    if (!open) return;
    const onEscapeCapture = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || isComposingKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener('keydown', onEscapeCapture, true);
    return () => document.removeEventListener('keydown', onEscapeCapture, true);
  }, [open]);

  // 等一帧让 portal 菜单真正挂载后再聚焦：优先当前选中项，否则第一个可用项。
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const active = menuRef.current?.querySelector<HTMLButtonElement>('[data-selected="true"]:not(:disabled)');
      (active ?? menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  /**
   * 选中一个选项：禁用项直接忽略；选择后关闭菜单并把焦点还给触发按钮，
   * 避免焦点落到已卸载的 portal 节点上。
   */
  function choose(next: SelectOption): void {
    if (disabled || next.disabled) return;
    onChange(next.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  // 触发按钮键盘：下箭头/Enter/空格打开菜单。preventDefault 阻止按钮的原生
  // click 激活再触发一次 onClick，导致刚打开又被切换关闭。
  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (disabled || isComposingKey(event.nativeEvent)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  }

  // 菜单键盘：Esc 关闭并把焦点还给触发按钮（stopPropagation 防止外层 dialog 一起关闭）；
  // 上下箭头在可用项之间移动，index 为 -1（焦点不在选项上）时落到第一项。
  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (isComposingKey(event.nativeEvent)) return;
    if (event.key === 'Tab') {
      // Continue the native tab order from the owning control, not the body portal.
      triggerRef.current?.focus({ preventScroll: true });
      setOpen(false);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = menuFocusIndex(event.key, index, items.length);
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  }

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  // 原生 dialog 本身就是顶层容器；自定义 role="dialog" 则挂到它的遮罩父层，
  // 既不会落到底层 z-index，也不会被卡片自身的 overflow 裁剪。
  // open 时 triggerRef 已存在，因此这里读取 ref 是安全的。
  const nativeDialog = triggerRef.current?.closest('dialog');
  const modalDialog = triggerRef.current?.closest('[aria-modal="true"]');
  const portalTarget = nativeDialog ?? modalDialog?.parentElement ?? document.body;

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
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next && !menuRef.current?.contains(next)) setOpen(false);
        }}
      >
        {leadingIcon && <span className="pi-select-leading" aria-hidden="true">{leadingIcon}</span>}
        <span className={selected ? 'pi-select-value' : 'pi-select-placeholder'}>{selected?.label ?? placeholder}</span>
        <ChevronDown className="pi-select-chevron" />
      </button>
      {open && createPortal(
        <PopoverSurface
          ref={menuRef}
          id={listId}
          className={`pi-select-menu ${menuClassName}`}
          role="listbox"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          onBlurCapture={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next && !menuRef.current?.contains(next) && !triggerRef.current?.contains(next)) setOpen(false);
          }}
        >
          {/* data-selected 供“打开菜单时聚焦已选项”查询，不能只依赖 aria-selected。 */}
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              tabIndex={-1}
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
        </PopoverSurface>,
        portalTarget,
      )}
    </div>
  );
}
