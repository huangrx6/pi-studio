import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Clock3, FolderOpen } from 'lucide-react';
import { DatePicker } from '../../shared/DatePicker';
import { addPickerDays, todayIsoDay } from '../../shared/date-picker';
import { errorText } from '../../shared/error-text';
import { Select } from '../../shared/Select';
import { SettingsDialog } from '../../shared/SettingsDialog';
import type { PlanSchedule, StudioPlan } from '../../types/plans';
import { localZone, stamp, weekdayNames, workingDays } from './plan-display';

type Cadence = PlanSchedule['kind'] | 'workdays';
const frequencies: { value: Cadence; label: string }[] = [
  { value: 'once', label: '仅一次' }, { value: 'daily', label: '每天' }, { value: 'workdays', label: '工作日' },
  { value: 'weekly', label: '每周' }, { value: 'monthly', label: '每月' }, { value: 'interval', label: '固定间隔' },
];
const monthDays = [
  { value: 'last', label: '最后一天' },
  ...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 日` })),
];

export function PlanEditor({ initial, workspaces, currentWorkspace, onChooseWorkspace, onClose }: {
  initial: Partial<StudioPlan>; workspaces: { cwd: string; name: string }[]; currentWorkspace: string;
  onChooseWorkspace: () => Promise<string | null | undefined>; onClose: () => void;
}) {
  const rule = initial.schedule;
  const [name, setName] = useState(initial.name ?? '');
  const [prompt, setPrompt] = useState(initial.prompt ?? '');
  const [workspace, setWorkspace] = useState(initial.workspace ??
    (workspaces.find(p => p.cwd === currentWorkspace)?.cwd || workspaces[0]?.cwd || ''));
  const [cadence, setCadence] = useState<Cadence>(rule?.kind === 'weekly' && rule.days.join(',') === workingDays.join(',') ? 'workdays' : rule?.kind ?? 'daily');
  const [days, setDays] = useState(rule?.kind === 'weekly' ? rule.days : [1]);
  const [monthDay, setMonthDay] = useState(String(rule?.kind === 'monthly' ? rule.day : 1));
  const [time, setTime] = useState(rule && 'time' in rule ? rule.time : '09:00');
  const [date, setDate] = useState(rule?.kind === 'once' ? rule.date : addPickerDays(todayIsoDay(), 1));
  const [minutes, setMinutes] = useState(String(rule?.kind === 'interval' ? rule.minutes : 60));
  const [endDate, setEndDate] = useState(rule?.endDate || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  const zone = rule?.zone || localZone();
  const schedule = useMemo<PlanSchedule>(() => {
    const common = { zone, ...(endDate ? { endDate } : {}) };
    switch (cadence) {
      case 'once': return { kind: 'once', zone, time, date };
      case 'interval': return { ...common, kind: 'interval', minutes: Number(minutes) };
      case 'daily': return { ...common, kind: 'daily', time };
      case 'monthly': return { ...common, kind: 'monthly', day: monthDay === 'last' ? 'last' : Number(monthDay), time };
      default: return { ...common, kind: 'weekly', days: cadence === 'workdays' ? workingDays : days, time };
    }
  }, [cadence, time, date, minutes, days, monthDay, endDate, zone]);
  useEffect(() => {
    let active = true;
    setPreview('');
    void window.piApi.planPreview(schedule, initial.id).then(at => {
      const label = initial.status === 'paused' ? '现在恢复，首次执行' : '下次执行';
      if (active) setPreview(at ? `${label}${zone === localZone() ? '' : '（本机时间）'} · ${stamp(at)}` : '没有未来的执行时间');
    }).catch(cause => { if (active) setPreview(errorText(cause)); });
    return () => { active = false; };
  }, [schedule, zone, initial.id, initial.status]);

  return <SettingsDialog className="plan-editor" title={initial.id ? '编辑计划' : '新建计划'} action={initial.id ? '保存更改' : '创建计划'}
    loading={false} busy={busy} error={error || null} unavailable={!name.trim() || !prompt.trim() || !workspace}
    onClose={onClose} onSubmit={async dismiss => {
      setBusy(true); setError('');
      try {
        await window.piApi.planSave({ id: initial.id, name, prompt, workspace, schedule });
        await dismiss(onClose);
      } catch (cause) { setBusy(false); setError(errorText(cause)); }
    }}>
    <div className="plan-form">
      <div className="plan-form-pair">
        <label className="settings-field"><span>计划名称</span>
          <input required maxLength={100} value={name} placeholder="例如，工作日项目简报" onChange={e => setName(e.target.value)} />
        </label>
        <div className="settings-field"><span>项目工作区</span><div className="plan-project-picker">
          <Select label="项目工作区" placeholder="选择项目" value={workspace} onChange={setWorkspace}
            options={workspaces.map(p => ({ value: p.cwd, label: p.name, description: p.cwd }))} />
          <button type="button" className="settings-outline" aria-label="打开项目文件夹" title="打开项目文件夹" onClick={async () => {
            try { const cwd = await onChooseWorkspace(); if (cwd) setWorkspace(cwd); }
            catch (cause) { setError(errorText(cause)); }
          }}><FolderOpen size={16} /></button>
        </div></div>
      </div>
      <label className="settings-field"><span>执行指令</span>
        <textarea required rows={3} maxLength={32000} value={prompt} placeholder="希望 Agent 在这个项目中完成什么？"
          onChange={e => setPrompt(e.target.value)} />
      </label>
      <section className="plan-timing" aria-labelledby="plan-timing-heading">
        <h3 id="plan-timing-heading"><CalendarClock aria-hidden="true" />执行安排</h3>
        <div className="plan-form-pair">
          <div className="settings-field"><span>执行频率</span>
            <Select label="执行频率" options={frequencies} value={cadence} onChange={v => setCadence(v as Cadence)} />
          </div>
          {cadence === 'interval' ? <label className="settings-field"><span>间隔分钟数</span>
            <input type="number" min="1" max="10080" required value={minutes} onChange={e => setMinutes(e.target.value)} />
          </label> : <label className="settings-field"><span>执行时间</span>
            <input type="time" required value={time} onChange={e => setTime(e.target.value)} />
          </label>}
        </div>
        {cadence === 'weekly' && <div className="plan-weekdays" role="group" aria-label="执行日">
          {[1, 2, 3, 4, 5, 6, 0].map(d => <button key={d} type="button" aria-label={`星期${weekdayNames[d]}`}
            aria-pressed={days.includes(d)} onClick={() => setDays(current => current.includes(d) ? current.filter(n => n !== d) : [...current, d])}>{weekdayNames[d]}</button>)}
        </div>}
        {cadence === 'monthly' && <div className="settings-field"><span>每月执行日</span>
          <Select label="每月执行日" options={monthDays} value={monthDay} onChange={setMonthDay} />
          {Number(monthDay) >= 29 && <small>没有这一天的月份会跳过。</small>}
        </div>}
        {cadence === 'once' ? <div className="settings-field"><span>执行日期</span>
          <DatePicker value={date} label="执行日期" onChange={setDate} />
        </div> : <div className="plan-end-date">
          <label><input type="checkbox" checked={!!endDate} onChange={e => setEndDate(e.target.checked ? addPickerDays(todayIsoDay(), 30) : '')} />设置结束日期</label>
          {endDate && <DatePicker value={endDate} label="结束日期（含当天）" onChange={setEndDate} />}
        </div>}
        <div className="plan-form-footnote" role="status"><Clock3 aria-hidden="true" />
          <div><strong>{preview || '正在计算执行时间…'}</strong><span>计划时区 {zone} · 使用项目模型和权限</span></div>
        </div>
      </section>
    </div>
  </SettingsDialog>;
}
