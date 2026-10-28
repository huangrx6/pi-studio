/**
 * 统一的自定义下拉选择器，替换原生 <select>（原生控件在各系统外观差异大）。
 *
 * 关键实现：
 * - 菜单通过 createPortal 渲染到最近的 <dialog>（没有则 body），避免被
 *   overflow 容器裁剪，也能留在原生 dialog 的顶层；
 * - 用 useLayoutEffect 在 paint 前计算 fixed 坐标，空间不足时向上展开；
 * - 支持点击外部关闭、Esc 关闭并归还焦点、上下键/Home/End 在选项间移动；
 * - 自定义组件需要手动补齐 listbox / option 的 aria 关系。
 *
 * 纯 UI 组件，不涉及 IPC。选项禁用时不可选，但当前值仍会显示。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { PopoverSurface } from './PopoverSurface';

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
};

/**
 * 菜单定位结果。left/width 为 fixed 坐标与宽度，top 与 bottom 二选一：
 * 向上展开时用 bottom（相对视口底部的距离），避免依赖菜单实际高度。
 */
type Placement = { left: number; top?: number; bottom?: number; width: number };

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
 * 自适应展开方向由下方 useLayoutEffect 计算：菜单预计高度放不下且上方更宽裕时，
 * 改为向上展开；同时把左边界夹在视口内，防止长下拉在窄窗口里溢出。
 */
export function Select({ value, options, onChange, label, placeholder = '请选择', disabled = false, autoFocus = false, className = '', menuClassName = '' }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);

  // 用 layout effect：必须在浏览器绘制前拿到位置，否则菜单会先闪在错误位置。
  // 菜单高度无法预先测量（尚未挂载），按 34px/项估算并限制在 260px；
  // 下方空间不足且上方更宽裕时改用 bottom 定位向上展开。
  // scroll 使用捕获阶段，关闭/重算能覆盖任意嵌套滚动容器。
  useLayoutEffect(() => {
    if (!open) return;
    const update = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const roomBelow = window.innerHeight - rect.bottom - 10;
      const hasDescriptions = options.some(option => option.description);
      const width = Math.min(window.innerWidth - 16, Math.max(rect.width, hasDescriptions ? 288 : 160));
      const estimatedHeight = Math.min(320, Math.max(80, options.length * (hasDescriptions ? 60 : 36) + 12));
      const showAbove = roomBelow < estimatedHeight && rect.top > roomBelow;
      setPlacement({
        // 菜单宽度独立于紧凑的触发按钮，长说明不再挤成竖排。
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        width,
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

  // 等一帧让 portal 菜单真正挂载后再聚焦：优先当前选中项，否则第一个可用项。
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const active = menuRef.current?.querySelector<HTMLButtonElement>('[data-selected="true"]');
      (active ?? menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  /**
   * 选中一个选项：禁用项直接忽略；选择后关闭菜单并把焦点还给触发按钮，
   * 避免焦点落到已卸载的 portal 节点上。
   */
  function choose(next: SelectOption): void {
    if (next.disabled) return;
    onChange(next.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  // 触发按钮键盘：下箭头/Enter/空格打开菜单。preventDefault 阻止按钮的原生
  // click 激活再触发一次 onClick，导致刚打开又被切换关闭。
  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  }

  // 菜单键盘：Esc 关闭并把焦点还给触发按钮（stopPropagation 防止外层 dialog 一起关闭）；
  // 上下箭头在可用项之间移动，index 为 -1（焦点不在选项上）时落到第一项。
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

  // 若选择器位于原生 <dialog> 内，挂到 dialog 上可留在顶层（否则会被 dialog 遮住）；
  // 其余场景挂到 body。open 时 triggerRef 已存在，因此这里读取 ref 是安全的。
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
      {/* placement 为 null 时先不渲染，避免菜单在拿到坐标前闪在左上角。 */}
      {open && placement && createPortal(
        <PopoverSurface
          ref={menuRef}
          id={listId}
          className={`pi-select-menu ${menuClassName}`}
          role="listbox"
          aria-label={label}
          style={{ left: placement.left, width: placement.width, top: placement.top, bottom: placement.bottom }}
          onKeyDown={onMenuKeyDown}
        >
          {/* data-selected 供“打开菜单时聚焦已选项”查询，不能只依赖 aria-selected。 */}
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
        </PopoverSurface>,
        portalTarget,
      )}
    </div>
  );
}
