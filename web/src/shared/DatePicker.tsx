/**
 * Shared date picker for forms and compact toolbars.
 *
 * It keeps the application's visual language instead of opening Chromium's
 * native calendar. The popover is portaled to the nearest dialog (or body),
 * positioned before paint, and supports pointer, keyboard, focus restoration,
 * range constraints and a fixed six-week calendar.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  DATE_PICKER_WEEKDAYS,
  addPickerDays,
  addPickerMonths,
  formatPickerDay,
  formatPickerMonth,
  isPickerDayDisabled,
  isSamePickerMonth,
  monthStart,
  parseIsoDay,
  pickerCalendarDays,
  pickerWeekday,
  todayIsoDay,
} from './date-picker.mjs';
import { PopoverSurface } from './PopoverSurface';
import './date-picker.css';

type DatePickerProps = {
  /** Current YYYY-MM-DD value. An empty string shows the placeholder. */
  value: string;
  onChange: (value: string) => void;
  /** Accessible name. The popover title is derived from it. */
  label: string;
  placeholder?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  className?: string;
};

type Placement = {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
};

const POPOVER_WIDTH = 296;
const POPOVER_HEIGHT = 346;

function monthEnd(month: string): string {
  return addPickerDays(addPickerMonths(month, 1), -1);
}

export function DatePicker({
  value,
  onChange,
  label,
  placeholder = '选择日期',
  min = '',
  max = '',
  disabled = false,
  className = '',
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(value || min || max));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const focusDayRef = useRef('');
  const days = useMemo(() => pickerCalendarDays(visibleMonth), [visibleMonth]);
  const currentValue = parseIsoDay(value) ? value : '';
  const displayValue = formatPickerDay(currentValue);
  const today = todayIsoDay();
  const currentMonthKey = visibleMonth.slice(0, 7);
  const previousMonth = addPickerMonths(visibleMonth, -1);
  const nextMonth = addPickerMonths(visibleMonth, 1);
  const canGoPrevious = !min || monthEnd(previousMonth) >= min;
  const canGoNext = !max || nextMonth <= max;
  const todayDisabled = isPickerDayDisabled(today, min, max);
  const tabStopDay = currentValue && isSamePickerMonth(currentValue, visibleMonth)
    ? currentValue
    : days.find((day) => (
      day.startsWith(currentMonthKey)
      && !isPickerDayDisabled(day, min, max)
    )) || days.find((day) => !isPickerDayDisabled(day, min, max)) || '';

  // Calculate fixed coordinates before paint so the popover never flashes at
  // the viewport origin or gets clipped by the analytics card.
  useLayoutEffect(() => {
    if (!open) return;
    const update = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - 16);
      const roomBelow = window.innerHeight - rect.bottom - 10;
      const roomAbove = rect.top - 10;
      const showAbove = roomBelow < POPOVER_HEIGHT && roomAbove > roomBelow;
      setPlacement({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        width,
        ...(showAbove
          ? { bottom: window.innerHeight - rect.top + 5 }
          : { top: rect.bottom + 5 }),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setVisibleMonth(monthStart(currentValue || min || max));
      return;
    }
    const frame = requestAnimationFrame(() => {
      const preferred = popoverRef.current?.querySelector<HTMLButtonElement>(
        `[data-date="${tabStopDay}"]`,
      );
      (preferred ?? popoverRef.current?.querySelector<HTMLButtonElement>(
        '.pi-date-day:not(:disabled)',
      ))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Escape closes only the date popover. Capture once so a surrounding native
  // settings dialog does not receive the same key and close at the same time.
  useEffect(() => {
    if (!open) return;
    const onEscapeCapture = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener('keydown', onEscapeCapture, true);
    return () => document.removeEventListener('keydown', onEscapeCapture, true);
  }, [open]);

  function openPicker(): void {
    if (disabled) return;
    setVisibleMonth(monthStart(currentValue || min || max));
    setOpen((current) => !current);
  }

  function closePicker(): void {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function choose(day: string): void {
    if (isPickerDayDisabled(day, min, max)) return;
    onChange(day);
    closePicker();
  }

  function shiftMonth(amount: number): void {
    setVisibleMonth((current) => addPickerMonths(current, amount));
  }

  function moveFocus(day: string): void {
    if (!day || isPickerDayDisabled(day, min, max)) return;
    focusDayRef.current = day;
    setVisibleMonth(monthStart(day));
    requestAnimationFrame(() => {
      const target = popoverRef.current?.querySelector<HTMLButtonElement>(
        `[data-date="${focusDayRef.current}"]`,
      );
      target?.focus();
    });
  }

  function onCalendarKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-date]');
    const day = target?.dataset.date;
    if (!day) return;
    let next = '';
    if (event.key === 'ArrowLeft') next = addPickerDays(day, -1);
    else if (event.key === 'ArrowRight') next = addPickerDays(day, 1);
    else if (event.key === 'ArrowUp') next = addPickerDays(day, -7);
    else if (event.key === 'ArrowDown') next = addPickerDays(day, 7);
    else if (event.key === 'Home') {
      const date = parseIsoDay(day);
      if (date) next = addPickerDays(day, -((date.getDay() + 6) % 7));
    } else if (event.key === 'End') {
      const date = parseIsoDay(day);
      if (date) next = addPickerDays(day, 6 - ((date.getDay() + 6) % 7));
    } else if (event.key === 'PageUp') next = addPickerMonths(day, -1);
    else if (event.key === 'PageDown') next = addPickerMonths(day, 1);
    if (!next) return;
    event.preventDefault();
    moveFocus(next);
  }

  const portalTarget = triggerRef.current?.closest('dialog') ?? document.body;

  return <div className={`pi-date-picker ${className}`}>
    <button
      ref={triggerRef}
      type="button"
      className={`pi-date-trigger ${open ? 'is-open' : ''}`}
      disabled={disabled}
      aria-label={`${label}${displayValue ? `，当前 ${displayValue}` : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={openPicker}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown') return;
        event.preventDefault();
        if (!open) {
          setVisibleMonth(monthStart(currentValue || min || max));
          setOpen(true);
        }
      }}
    >
      <CalendarDays className="pi-date-leading" />
      <span className={displayValue ? 'pi-date-value' : 'pi-date-placeholder'}>
        {displayValue || placeholder}
      </span>
      <ChevronDown className="pi-date-chevron" />
    </button>
    {open && placement && createPortal(
      <PopoverSurface
        ref={popoverRef}
        className="pi-date-popover"
        role="dialog"
        aria-modal="false"
        aria-label={`选择${label}`}
        style={{
          left: placement.left,
          width: placement.width,
          top: placement.top,
          bottom: placement.bottom,
        }}
      >
        <div className="pi-date-calendar-head">
          <button
            type="button"
            className="pi-date-nav"
            aria-label="上个月"
            disabled={!canGoPrevious}
            onClick={() => shiftMonth(-1)}
          ><ChevronLeft /></button>
          <strong className="pi-date-month" data-month={currentMonthKey} aria-live="polite">
            {formatPickerMonth(visibleMonth)}
          </strong>
          <button
            type="button"
            className="pi-date-nav"
            aria-label="下个月"
            disabled={!canGoNext}
            onClick={() => shiftMonth(1)}
          ><ChevronRight /></button>
        </div>
        <div className="pi-date-weekdays" aria-hidden="true">
          {DATE_PICKER_WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
        </div>
        <div className="pi-date-grid" role="group" aria-label="选择日期" onKeyDown={onCalendarKeyDown}>
          {days.map((day) => {
            const isSelected = day === currentValue;
            const isToday = day === today;
            const outsideMonth = !isSamePickerMonth(day, visibleMonth);
            return <button
              type="button"
              key={day}
              data-date={day}
              className={[
                'pi-date-day',
                outsideMonth ? 'is-outside-month' : '',
                isToday ? 'is-today' : '',
                isSelected ? 'is-selected' : '',
              ].filter(Boolean).join(' ')}
              tabIndex={day === tabStopDay ? 0 : -1}
              disabled={isPickerDayDisabled(day, min, max)}
              aria-label={`${day}，${pickerWeekday(day)}${isToday ? '，今天' : ''}`}
              aria-selected={isSelected}
              aria-current={isToday ? 'date' : undefined}
              onClick={() => choose(day)}
            >{Number(day.slice(-2))}</button>;
          })}
        </div>
        <footer className="pi-date-footer">
          <button type="button" className="pi-date-footer-action" onClick={closePicker}>取消</button>
          <button
            type="button"
            className="pi-date-footer-action is-primary"
            disabled={todayDisabled}
            onClick={() => choose(today)}
          >今天</button>
        </footer>
      </PopoverSurface>,
      portalTarget,
    )}
  </div>;
}
