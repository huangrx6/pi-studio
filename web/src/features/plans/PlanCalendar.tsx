import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRef } from 'react';
import { addPickerDays, isoDay, parseIsoDay } from '../../shared/date-picker';
import type { PlanWeek, StudioPlan } from '../../types/plans';
import { timeLabel, weekdayNames } from './plan-display';

const shortDate = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
const fullDate = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', year: 'numeric' });

function rangeLabel(first: Date, last: Date) {
  if (first.getFullYear() !== last.getFullYear()) return fullDate.format(first) + ' – ' + fullDate.format(last);
  return fullDate.format(first) + ' – ' + (first.getMonth() === last.getMonth() ? last.getDate() + '日' : shortDate.format(last));
}

export function PlanCalendar({ dates, entries, selected, today, next, onSelect }: {
  dates: string[]; entries?: PlanWeek['days']; selected: string; today: string;
  next?: StudioPlan; onSelect: (day: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const nextAt = next?.nextAt;
  const nextDay = nextAt != null ? isoDay(new Date(nextAt)) : '';
  const heading = rangeLabel(parseIsoDay(dates[0])!, parseIsoDay(dates[6])!);
  return <section className="plan-calendar" aria-label="周日程">
    <div className="plan-calendar-week">
      <header className="plan-calendar-header">
        <h2>{heading}</h2>
        <nav aria-label="切换日程周">
          <button type="button" className="icon-button" aria-label="上一周" title="上一周" onClick={() => onSelect(addPickerDays(selected, -7))}><ChevronLeft /></button>
          <button type="button" className="plan-today" title="回到今天的日程" onClick={() => onSelect(today)}>今天</button>
          <button type="button" className="icon-button" aria-label="下一周" title="下一周" onClick={() => onSelect(addPickerDays(selected, 7))}><ChevronRight /></button>
        </nav>
      </header>
      <div className="plan-date-strip" role="group" aria-label="选择日期" ref={strip}>
        {dates.map((day, index) => {
          const date = parseIsoDay(day)!;
          const items = entries?.[index] || [];
          const current = day === today;
          const marked = items.length > 0;
          const status = items.some(item => item.status === 'failed') ? 'failed'
            : items.some(item => item.status !== 'cancelled') ? 'active' : 'cancelled';
          const label = shortDate.format(date) + ' 周' + weekdayNames[date.getDay()] + (current ? '，今天' : '') + (marked ? '，有安排' : '') + (status === 'failed' ? '，有执行失败' : '');
          return <button type="button" key={day} data-date={day} aria-label={label} title={label} aria-pressed={day === selected}
            aria-current={current ? 'date' : undefined} tabIndex={day === selected ? 0 : -1}
            onClick={() => onSelect(day)} onKeyDown={event => {
              const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: 6 }[event.key];
              if (target === undefined) return;
              event.preventDefault();
              const nextDate = addPickerDays(dates[0], target);
              onSelect(nextDate);
              requestAnimationFrame(() => strip.current?.querySelector<HTMLButtonElement>('[data-date="' + nextDate + '"]')?.focus());
            }}>
            <span>{current ? '今天' : '周' + weekdayNames[date.getDay()]}</span>
            <strong>{date.getDate()}{marked && <i aria-hidden="true" className={'plan-date-mark mark-' + status} />}</strong>
          </button>;
        })}
      </div>
    </div>
    <div className="plan-upcoming">
      <h2>下次执行</h2>
      {next && nextAt != null ? <button type="button" onClick={() => onSelect(nextDay)} title="查看这一天的日程">
        <time className="plan-upcoming-time" dateTime={new Date(nextAt).toISOString()}>{timeLabel(nextAt)}</time>
        <span className="plan-upcoming-caption"><span>{shortDate.format(nextAt)} {nextDay === today ? '今天' : '周' + weekdayNames[new Date(nextAt).getDay()]}</span>
          <span className="plan-upcoming-name">{next.name}</span></span>
      </button> : <p className="plan-upcoming-empty"><span aria-hidden="true">—</span><span className="sr-only">暂无待执行计划</span></p>}
    </div>
  </section>;
}
