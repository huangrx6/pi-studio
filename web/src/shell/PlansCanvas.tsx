import { CalendarDays, Ellipsis, History, Pause, Pencil, Play, Plus, Square, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { PlanCalendar } from '../features/plans/PlanCalendar';
import { PlanDayAgenda } from '../features/plans/PlanDayAgenda';
import { PlanEditor } from '../features/plans/PlanEditor';
import { PlanRuns } from '../features/plans/PlanRuns';
import { localZone, mondayOf, runStatus, scheduleLabel, timeLabel, weekDays } from '../features/plans/plan-display';
import { ActionMenu } from '../shared/ActionMenu';
import { addPickerDays, isoDay, parseIsoDay, todayIsoDay } from '../shared/date-picker';
import { useActionConfirmation } from '../shared/ConfirmDialog';
import { errorText } from '../shared/error-text';
import { LoadingState } from '../shared/LoadingState';
import { Select } from '../shared/Select';
import type { PlanAction, PlanWeek, StudioPlan } from '../types/plans';
import type { PlansView } from './AppSidebar';
import { ShellHeader } from './ShellLayout';
import type { PiWorkspace } from './app-types';
import './styles/plans-canvas.css';
import '../features/plans/styles/agenda.css';
import '../features/plans/styles/plans.css';

export function PlansCanvas({ view, onViewChange, workspaces, currentWorkspace, onReloadProjects, onOpenSession, onExpandSidebar }: {
  view: PlansView; onViewChange: (view: PlansView) => void;
  workspaces: PiWorkspace[]; currentWorkspace: string; onReloadProjects: () => Promise<void>;
  onOpenSession: (id: string) => void; onExpandSidebar?: () => void;
}) {
  const [plans, setPlans] = useState<StudioPlan[] | null>(null);
  const [week, setWeek] = useState<{ monday: string; days: PlanWeek['days'] } | null>(null);
  const [today, setToday] = useState(todayIsoDay);
  const [chosenDay, setChosenDay] = useState<string | null>(null);
  const selected = chosenDay ?? today;
  const monday = mondayOf(selected);
  const dates = useMemo(() => weekDays(monday), [monday]);
  const [revision, setRevision] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Partial<StudioPlan> | null>(null);
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [filter, setFilter] = useState('');
  const [pending, setPending] = useState(false);
  const confirm = useActionConfirmation();
  useEffect(() => window.piApi.onPlansChanged(() => setRevision(n => n + 1)), []);
  useEffect(() => {
    if (view !== 'plans') return;
    let timer: number;
    function syncDate() {
      window.clearTimeout(timer);
      if (document.hidden) return;
      const now = new Date();
      setToday(todayIsoDay());
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      timer = window.setTimeout(syncDate, midnight.getTime() - now.getTime());
    }
    syncDate();
    document.addEventListener('visibilitychange', syncDate);
    window.addEventListener('focus', syncDate);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', syncDate);
      window.removeEventListener('focus', syncDate);
    };
  }, [view]);
  useEffect(() => {
    let active = true;
    async function load() {
      if (view === 'plans') {
        const boundaries = [...dates, addPickerDays(monday, 7)].map(day => parseIsoDay(day)!.setHours(0, 0, 0, 0));
        const result = await window.piApi.planWeek(boundaries);
        if (!active) return;
        setWeek({ monday, days: result.days });
        setPlans(result.plans);
      } else {
        const result = await window.piApi.planList();
        if (!active) return;
        setPlans(result);
      }
      setLoadError('');
    }
    void load().catch(cause => { if (active) setLoadError(errorText(cause)); });
    return () => { active = false; };
  }, [revision, view, monday, dates, today]);
  useEffect(() => { setMenu(null); setError(''); }, [view]);

  const workspaceName = (cwd: string) => workspaces.find(w => w.cwd === cwd)?.name || cwd;
  const next = plans?.find(plan => plan.nextAt !== null);
  const days = week?.monday === monday ? week.days : undefined;
  const entries = days?.[dates.indexOf(selected)];
  const menuPlan = plans?.find(plan => plan.id === menu?.id);
  const selection = plans?.some(plan => plan.id === filter) ? filter : '';
  function chooseDay(day: string) { setChosenDay(day === today ? null : day); }
  function createPlan() {
    const emptyToday = selected === today && !!plans?.length && entries?.length === 0;
    if (selected <= today && !emptyToday) { setDraft({}); return; }
    const slot = parseIsoDay(selected)!;
    slot.setHours(9, 0, 0, 0);
    const now = Date.now();
    if (slot.getTime() <= now) {
      const lastMinute = slot.setHours(23, 59, 0, 0);
      const nextQuarterHour = (Math.floor(now / 900_000) + 1) * 900_000;
      slot.setTime(lastMinute > now ? Math.min(nextQuarterHour, lastMinute) : nextQuarterHour);
    }
    setDraft({ schedule: { kind: 'once', zone: localZone(), time: timeLabel(slot.getTime()), date: isoDay(slot) } });
  }
  function showHistory(id: string | null) { setFilter(id ?? ''); onViewChange('runs'); }
  async function act(action: PlanAction, id: string) {
    setPending(true); setError('');
    try { await window.piApi.planAction(action, id); }
    catch (cause) { setError(errorText(cause)); }
    finally { setPending(false); }
  }
  async function remove(plan: StudioPlan) {
    if (await confirm.confirm({ title: '删除计划', description: `删除「${plan.name}」后将停止安排，已有运行记录会保留。`, confirmLabel: '删除计划', tone: 'danger' })) {
      await act('delete', plan.id);
    }
  }

  return <>
    <ShellHeader className="chat-header" onExpandSidebar={onExpandSidebar} />
    <main className="main shell-canvas plans-canvas" aria-label={view === 'runs' ? '运行记录' : '计划列表'}>
      <div className="plans-page">
        <header className="plans-heading">
          <h1>{view === 'runs' ? '运行记录' : '执行日程'}</h1>
          {view === 'plans' ? <button type="button" className="secondary-button" aria-haspopup="dialog" onClick={createPlan}>
            <Plus aria-hidden="true" />新建计划
          </button> :
            <Select label="筛选计划" value={selection} onChange={setFilter} options={[
              { value: '', label: '所有计划' }, ...(plans || []).map(plan => ({ value: plan.id, label: plan.name, description: workspaceName(plan.workspace) })),
            ]} />}
          {view === 'plans' && <p className="plan-runtime"><span data-ready={!!plans && !loadError}>{loadError ? '调度状态未知' : plans ? '本机运行中' : '正在连接本机'}</span>
            <span title="唤醒或重新启动后，每项计划错过的多次执行会合并补跑一次；超过结束日期的计划会结束。">休眠或退出期间错过的执行会合并补跑</span></p>}
        </header>
        {(loadError || error) && <div role="alert" className="plans-notice">{loadError || error}
          {loadError && <button onClick={() => setRevision(n => n + 1)}>重试</button>}</div>}
        {view === 'runs' ? <PlanRuns key={selection} revision={revision} filter={selection} workspaceName={workspaceName}
          onStop={id => void act('stop', id)} onOpen={run => { if (run.sessionId) onOpenSession(run.sessionId); }} /> :
          !plans ? !loadError && <LoadingState>正在读取计划…</LoadingState> : <>
            <PlanCalendar dates={dates} entries={days} selected={selected} today={today} next={next} onSelect={chooseDay} />
            <PlanDayAgenda day={selected} today={today} entries={entries} plans={plans} workspaceName={workspaceName}
              onEdit={setDraft} onHistory={showHistory} />
            {plans.length > 0 && <section className="plan-agenda" aria-label="已创建的计划">
              <h2 className="plan-section-label">我的计划 <span>{plans.length} 项</span></h2>
              <ul>{plans.map(plan => <li key={plan.id}>
                <button className="plan-agenda-name" title="编辑计划" onClick={() => setDraft(plan)}>
                  <strong>{plan.name}</strong><small>{workspaceName(plan.workspace)} · {scheduleLabel(plan.schedule)}
                    {plan.schedule.zone !== localZone() && ` · ${plan.schedule.zone}`}</small>
                </button>
                <span className={`plan-state state-${plan.runStatus ?? plan.status}`}>{plan.runStatus ? runStatus[plan.runStatus] :
                  plan.status === 'active' ? '已启用' : plan.status === 'paused' ? '已暂停' : '已结束'}</span>
                <div className="plan-row-actions">
                  <button className="icon-button" disabled={pending} aria-label={`${plan.activeRunId ? '停止' : '立即运行'} ${plan.name}`}
                    title={plan.activeRunId ? '停止本次运行' : '立即运行'} onClick={() => void act(plan.activeRunId ? 'stop' : 'run', plan.activeRunId || plan.id)}>
                    {plan.activeRunId ? <Square /> : <Play />}
                  </button>
                  <button className="icon-button" disabled={pending} aria-haspopup="menu" aria-label={`${plan.name}的操作`} title="计划操作"
                    onClick={e => setMenu({ id: plan.id, anchor: e.currentTarget })}><Ellipsis /></button>
                </div>
              </li>)}</ul>
            </section>}
          </>}
      </div>
    </main>
    {menu && menuPlan && <ActionMenu anchor={menu.anchor} placement="below" align="end" onClose={() => setMenu(null)} items={[
      { label: '编辑计划', icon: Pencil, run: () => setDraft(menuPlan) },
      ...(menuPlan.status === 'completed' ? [] : [{ label: menuPlan.status === 'paused' ? '恢复计划' : '暂停计划', icon: menuPlan.status === 'paused' ? CalendarDays : Pause,
        run: () => void act(menuPlan.status === 'paused' ? 'resume' : 'pause', menuPlan.id) }]),
      { label: '查看运行记录', icon: History, run: () => showHistory(menuPlan.id) },
      { label: '删除计划', icon: Trash2, destructive: true, disabled: !!menuPlan.activeRunId, run: () => void remove(menuPlan) },
    ]} />}
    {draft && <PlanEditor initial={draft} workspaces={workspaces} currentWorkspace={currentWorkspace} onClose={() => setDraft(null)}
      onChooseWorkspace={async () => { const cwd = await window.piApi.chooseWorkspace(); if (cwd) await onReloadProjects(); return cwd; }} />}
    {confirm.dialog}
  </>;
}
