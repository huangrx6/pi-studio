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
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clock3 } from 'lucide-react';
import {
  DATE_PICKER_WEEKDAYS,
  addPickerDays,
  addPickerMonths,
  formatPickerDay,
  formatPickerMonth,
  isPickerDayDisabled,
  isSamePickerMonth,
  monthStart,
  normalizePickerTime,
  parseIsoDay,
  pickerCalendarDays,
  pickerWeekday,
  todayIsoDay,
} from './date-picker.ts';
import { PopoverSurface, popoverPortalTarget } from './PopoverSurface';
import { isComposingKey } from './keyboard-navigation';
import './styles/date-picker.css';

type DatePickerProps = {
  /** YYYY-MM-DD, or local YYYY-MM-DDTHH:mm with includeTime. Empty shows the placeholder. */
  value: string;
  onChange: (value: string) => void;
  /** Accessible name. The popover title is derived from it. */
  label: string;
  placeholder?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  className?: string;
  includeTime?: boolean;
};

type Placement = {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight?: number;
};

const POPOVER_WIDTH = 296;
const POPOVER_HEIGHT = 346;
const TIME_POPOVER_HEIGHT = 398;

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
  includeTime = false,
}: DatePickerProps) {
  const [valueDay, valueTime = ''] = includeTime ? value.split('T') : [value];
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(valueDay || min || max));
  const [draft, setDraft] = useState({ day: '', time: '' });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const popoverRef = useRef<HTMLDivElement>(null);
  const focusDayRef = useRef('');
  const days = useMemo(() => pickerCalendarDays(visibleMonth), [visibleMonth]);
  const committedDay = parseIsoDay(valueDay) ? valueDay : '';
  const selectedDay = includeTime && open ? draft.day : committedDay;
  const displayDay = formatPickerDay(committedDay);
  const displayValue = displayDay && valueTime ? displayDay + ' ' + valueTime : displayDay;
  const draftTime = normalizePickerTime(draft.time);
  const today = todayIsoDay();
  const currentMonthKey = visibleMonth.slice(0, 7);
  const previousMonth = addPickerMonths(visibleMonth, -1);
  const nextMonth = addPickerMonths(visibleMonth, 1);
  const canGoPrevious = Boolean(parseIsoDay(previousMonth)) && (!min || monthEnd(previousMonth) >= min);
  const canGoNext = Boolean(parseIsoDay(nextMonth)) && (!max || nextMonth <= max);
  const todayDisabled = isPickerDayDisabled(today, min, max);
  const tabStopDay = selectedDay && !isPickerDayDisabled(selectedDay, min, max) && isSamePickerMonth(selectedDay, visibleMonth)
    ? selectedDay
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
      const height = includeTime ? TIME_POPOVER_HEIGHT : POPOVER_HEIGHT;
      const showAbove = roomBelow < height && roomAbove > roomBelow;
      setPlacement({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        width,
        maxHeight: Math.max(0, showAbove ? roomAbove : roomBelow),
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
  }, [includeTime, open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const preferred = popoverRef.current?.querySelector<HTMLButtonElement>(
        `[data-date="${tabStopDay}"]:not(:disabled)`,
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

  function openPicker(): void {
    if (disabled || open) return;
    const initialDay = committedDay || (includeTime && !todayDisabled ? today : '');
    setVisibleMonth(monthStart(initialDay || min || max));
    if (includeTime) setDraft({ day: initialDay, time: valueTime });
    setOpen(true);
  }

  function closePicker(): void {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function choose(day: string): void {
    if (disabled || isPickerDayDisabled(day, min, max)) return;
    if (includeTime) {
      setDraft(current => ({ ...current, day }));
      return;
    }
    onChange(day);
    closePicker();
  }

  function applyDateTime(): void {
    if (disabled || !draftTime || isPickerDayDisabled(draft.day, min, max)) return;
    onChange(draft.day + 'T' + draftTime);
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
    if (isComposingKey(event.nativeEvent)) return;
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

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const portalTarget = popoverPortalTarget(triggerRef.current);

  return <div className={`pi-date-picker ${className}`}>
    <button
      ref={triggerRef}
      type="button"
      className={`pi-date-trigger ${open ? 'is-open' : ''}`}
      disabled={disabled}
      aria-label={`${label}${displayValue ? `，当前 ${displayValue}` : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? popoverId : undefined}
      onClick={open ? closePicker : openPicker}
      onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next && !popoverRef.current?.contains(next)) setOpen(false);
        }}
      onKeyDown={(event) => {
        if (disabled || event.key !== 'ArrowDown' || isComposingKey(event.nativeEvent)) return;
        event.preventDefault();
        openPicker();
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
        id={popoverId}
        topLayer={portalTarget.matches('dialog, .settings-overlay')}
        className={`pi-date-popover${includeTime ? ' has-time' : ''}`}
        onBlurCapture={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next && !popoverRef.current?.contains(next) && !triggerRef.current?.contains(next)) setOpen(false);
        }}
        role="dialog"
        aria-modal="false"
        aria-label={`选择${label}`}
        style={{
          left: placement.left,
          width: placement.width,
          top: placement.top,
          bottom: placement.bottom,
          maxHeight: placement.maxHeight,
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
            const isSelected = day === selectedDay;
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
        {includeTime ? <>
          <label className="pi-date-time">
            <Clock3 aria-hidden="true" />
            <span>时间</span>
            <input
              aria-label="时分"
              title="输入 24 小时制时间，例如 09:30"
              inputMode="numeric"
              placeholder="HH:mm"
              maxLength={5}
              value={draft.time}
              onChange={event => setDraft(current => ({ ...current, time: event.target.value }))}
              onKeyDown={event => {
                if (event.key !== 'Enter' || isComposingKey(event.nativeEvent)) return;
                event.preventDefault();
                applyDateTime();
              }}
            />
          </label>
          <footer className="pi-date-footer">
            <button type="button" className="pi-date-footer-action" disabled={!value}
              onClick={() => { onChange(''); closePicker(); }}>清除</button>
            <button type="button" className="pi-date-time-confirm"
              disabled={!draftTime || isPickerDayDisabled(draft.day, min, max)}
              onClick={applyDateTime}>确定</button>
          </footer>
        </> : <footer className="pi-date-footer">
          <button type="button" className="pi-date-footer-action" onClick={closePicker}>取消</button>
          <button
            type="button"
            className="pi-date-footer-action is-primary"
            disabled={todayDisabled}
            onClick={() => choose(today)}
          >今天</button>
        </footer>}
      </PopoverSurface>,
      portalTarget,
    )}
  </div>;
}
