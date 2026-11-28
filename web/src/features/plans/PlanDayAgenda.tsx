import { parseIsoDay } from '../../shared/date-picker';
import { LoadingState } from '../../shared/LoadingState';
import type { PlanDayEntry, StudioPlan } from '../../types/plans';
import { runStatus, scheduleLabel, timeLabel, weekdayNames } from './plan-display';
import { PlanTemplates } from './PlanTemplates';

export function PlanDayAgenda({ day, today, entries, plans, workspaceName, onEdit, onHistory }: {
  day: string; today: string; entries?: PlanDayEntry[]; plans: StudioPlan[];
  workspaceName: (cwd: string) => string;
  onEdit: (draft: Partial<StudioPlan>) => void; onHistory: (id: string | null) => void;
}) {
  const date = parseIsoDay(day)!;
  const isPast = day < today;
  const label = (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日';
  return <div className="plan-day-layout">
    <section className="plan-day" aria-labelledby="plan-day-heading">
      <header className="plan-list-heading"><h2 className="plan-section-label" id="plan-day-heading">
        {day === today ? '今日日程' : '当日日程'}<span>{label} · 周{weekdayNames[date.getDay()]}</span>
      </h2></header>
      {!entries ? <LoadingState>正在读取当日日程…</LoadingState> : entries.length ? <ol className="plan-day-list">
        {entries.map(entry => {
          const plan = plans.find(item => item.id === entry.planId);
          const scheduled = entry.status === 'scheduled';
          const detail = scheduled && plan?.schedule.kind === 'interval' ? scheduleLabel(plan.schedule)
            : entry.runs > 1 ? '当天 ' + entry.runs + ' 次，显示最近一次' : '';
          return <li key={JSON.stringify([entry.planId, entry.workspace, entry.name, scheduled])}>
            <time dateTime={new Date(entry.at).toISOString()}>{timeLabel(entry.at)}</time>
            <button className="plan-day-item" title={scheduled ? '编辑计划' : '查看运行记录'}
              onClick={() => { if (scheduled && plan) onEdit(plan); else onHistory(entry.planId); }}>
              <strong>{entry.name}</strong><small>{workspaceName(entry.workspace)}{detail && ' · ' + detail}</small>
              <span className={'plan-state state-' + entry.status}>{entry.status === 'scheduled' ? '待执行' : runStatus[entry.status]}</span>
            </button>
          </li>;
        })}
      </ol> : <div className="plan-day-empty">
        <div className="plan-hour-ruler" aria-hidden="true">
          {['00:00', '08:00', '16:00', '24:00'].map(hour => <span key={hour}>{hour}</span>)}
        </div>
        <p className="plan-empty-note">{day === today ? '今天还没有安排' : isPast ? '当天没有执行记录' : '这一天还没有安排'}</p>
      </div>}
    </section>
    <PlanTemplates onEdit={onEdit} />
  </div>;
}
