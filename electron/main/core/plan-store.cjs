const { randomUUID } = require('node:crypto');
const { normalizeSchedule, occurrence, pastEndDate } = require('./plan-schedule.cjs');

function requiredText(value, max, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new Error(`${label}须为 1 至 ${max} 个字符`);
  return text;
}

function futureTime(rule, now) {
  const at = occurrence(rule, now);
  if (at === null) throw new Error('这个安排没有未来的执行时间，请调整日期或时间');
  return at;
}

class PlanStore {
  constructor(studio) {
    this.studio = studio;
    this.db = studio.db;
  }

  plan(id) {
    const plan = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
    if (!plan) throw new Error('计划已不存在');
    return plan;
  }

  preview(input, id, now) {
    const rule = normalizeSchedule(input);
    if (id) {
      const plan = this.plan(id);
      if (plan.status !== 'paused' && plan.schedule === JSON.stringify(rule)) return plan.next_at;
    }
    return occurrence(rule, now);
  }

  save(input, now) {
    const name = requiredText(input.name, 100, '计划名称');
    const prompt = requiredText(input.prompt, 32000, '执行指令');
    if (typeof input.workspace !== 'string' || !this.studio.getWorkspace(input.workspace)) throw new Error('请选择已打开的项目');
    const rule = normalizeSchedule(input.schedule);
    const schedule = JSON.stringify(rule);
    return this.studio.transaction(() => {
      const existing = input.id ? this.plan(input.id) : null;
      const id = existing?.id || randomUUID();
      const changed = !existing || existing.schedule !== schedule;
      const next = changed ? futureTime(rule, now) : existing.next_at;
      const status = existing?.status === 'paused' ? 'paused' : changed ? 'active' : existing.status;
      this.db.prepare(`
        INSERT INTO plans(id, workspace, name, prompt, schedule, status, next_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace, name=excluded.name, prompt=excluded.prompt,
          schedule=excluded.schedule, status=excluded.status, next_at=excluded.next_at
      `).run(id, input.workspace, name, prompt, schedule, status, status === 'active' ? next : null);
      return id;
    });
  }

  setPaused(id, paused, now) {
    this.studio.transaction(() => {
      const plan = this.plan(id);
      if ((paused && plan.status === 'paused') || (!paused && plan.status === 'active')) return;
      const next = paused ? null : futureTime(JSON.parse(plan.schedule), now);
      this.db.prepare('UPDATE plans SET status=?, next_at=? WHERE id=?').run(paused ? 'paused' : 'active', next, id);
      if (paused) this.db.prepare(`UPDATE plan_runs SET status='cancelled', finished_at=?, detail='计划已暂停', prompt=''
        WHERE plan_id=? AND status='queued' AND trigger='scheduled'`).run(now, id);
    });
  }

  remove(id) {
    this.studio.transaction(() => {
      this.plan(id);
      if (this.activeRun(id)) throw new Error('请先停止本次运行，再删除计划');
      this.db.prepare('DELETE FROM plans WHERE id=?').run(id);
    });
  }

  activeRun(id) {
    return this.db.prepare("SELECT id FROM plan_runs WHERE plan_id=? AND status IN ('queued','running')").get(id);
  }

  enqueue(plan, trigger, due, now) {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO plan_runs(id, plan_id, workspace, name, prompt, trigger, due_at, queued_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`).run(id, plan.id, plan.workspace, plan.name, plan.prompt, trigger, due, now);
    return id;
  }

  runNow(id, now) {
    return this.studio.transaction(() => {
      const plan = this.plan(id);
      if (this.activeRun(id)) throw new Error('这个计划已有一次运行在排队或执行中');
      return this.enqueue(plan, 'manual', now, now);
    });
  }

  nextAlarm() {
    return this.db.prepare("SELECT MIN(next_at) AS at FROM plans WHERE status='active'").get().at;
  }

  collectDue(now) {
    const due = this.db.prepare("SELECT * FROM plans WHERE status='active' AND next_at<=? ORDER BY next_at,id").all(now);
    if (!due.length) return false;
    this.studio.transaction(() => {
      for (const plan of due) {
        const rule = JSON.parse(plan.schedule);
        const next = occurrence(rule, now, { anchor: plan.next_at });
        if (!this.activeRun(plan.id) && !pastEndDate(rule, now)) {
          const latest = occurrence(rule, now, { previous: true, anchor: plan.next_at });
          this.enqueue(plan, 'scheduled', latest ?? plan.next_at, now);
        }
        this.db.prepare('UPDATE plans SET next_at=?, status=? WHERE id=?').run(next, next === null ? 'completed' : 'active', plan.id);
      }
    });
    return true;
  }

  claim(now) {
    return this.studio.transaction(() => {
      const running = this.db.prepare("SELECT * FROM plan_runs WHERE status='running' LIMIT 1").get();
      if (running) return running;
      return this.db.prepare(`UPDATE plan_runs SET status='running', started_at=?
        WHERE id=(SELECT id FROM plan_runs WHERE status='queued' ORDER BY queued_at,rowid LIMIT 1) RETURNING *`).get(now);
    });
  }

  bindSession(id, sessionId) {
    if (!this.db.prepare("UPDATE plan_runs SET session_id=? WHERE id=? AND status='running'").run(sessionId, id).changes) {
      throw new Error('计划运行已移除');
    }
  }

  requestStop(id, reason, now) {
    this.db.prepare(`UPDATE plan_runs SET stop_reason=?, detail=?,
      finished_at=CASE WHEN status='queued' THEN ? ELSE finished_at END,
      prompt=CASE WHEN status='queued' THEN '' ELSE prompt END,
      status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END
      WHERE id=? AND status IN ('running','queued') AND stop_reason=''`).run(reason, reason, now, id);
  }

  finish(id, status, detail, now) {
    const result = String(detail || '');
    this.db.prepare(`UPDATE plan_runs SET status=?, detail=?, finished_at=?, prompt='' WHERE id=? AND status='running'`)
      .run(status, result.length > 2000 ? result.slice(0, 1999) + '…' : result, now, id);
  }

  listPlans() {
    return this.db.prepare(`SELECT p.id,p.workspace,p.name,p.prompt,p.schedule,p.status,p.next_at AS nextAt,
        r.id AS activeRunId, r.status AS runStatus
      FROM plans p LEFT JOIN plan_runs r ON r.plan_id=p.id AND r.status IN ('queued','running')
      ORDER BY p.next_at IS NULL,p.next_at,p.name,p.id`).all()
      .map(row => ({ ...row, schedule: JSON.parse(row.schedule) }));
  }

  week(boundaries, now) {
    // The renderer supplies local midnights, including short and long DST days.
    if (!Array.isArray(boundaries) || boundaries.length !== 8 || boundaries.some((at, index) =>
      !Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime()) ||
      (index > 0 && (at <= boundaries[index - 1] || at - boundaries[index - 1] > 26 * 3_600_000)))) {
      throw new Error('日程日期范围无效');
    }
    const plans = this.listPlans();
    const latestRuns = this.db.prepare(`
      SELECT plan_id AS planId, name, workspace, status, MAX(queued_at) AS at, COUNT(*) AS runs
      FROM plan_runs WHERE trigger='scheduled' AND queued_at>=? AND queued_at<?
      GROUP BY plan_id, CASE WHEN plan_id IS NULL THEN workspace END, CASE WHEN plan_id IS NULL THEN name END`);
    // SQLite takes the ungrouped columns from the row containing MAX(queued_at).
    const days = boundaries.slice(0, 7).map((start, index) =>
      start <= now ? latestRuns.all(start, Math.min(now + 1, boundaries[index + 1])) : []);
    const from = Math.max(boundaries[0], now);
    const end = boundaries[7];
    for (const plan of plans) {
      if (from >= end || plan.nextAt === null || plan.nextAt >= end) continue;
      let at = plan.nextAt >= from ? plan.nextAt : occurrence(plan.schedule, from - 1, { anchor: plan.nextAt });
      // Jump to the next local day even for a plan that fires every minute.
      for (let day = 0; at !== null && at < end && day < 7; day++) {
        const midnight = boundaries[day + 1];
        if (at >= midnight) continue;
        days[day].push({ planId: plan.id, name: plan.name, workspace: plan.workspace, at, status: 'scheduled', runs: 0 });
        if (day < 6) at = occurrence(plan.schedule, midnight - 1, { anchor: plan.nextAt });
      }
    }
    for (const entries of days) entries.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
    return { plans, days };
  }

  history(cursor, planId) {
    const clauses = [], params = [];
    if (cursor) {
      if (!Number.isSafeInteger(cursor.at) || typeof cursor.id !== 'string') throw new Error('运行记录分页无效');
      clauses.push('(r.queued_at,r.id)<(?,?)');
      params.push(cursor.at, cursor.id);
    }
    if (planId) { clauses.push('r.plan_id=?'); params.push(planId); }
    const rows = this.db.prepare(`SELECT r.id,r.plan_id AS planId,r.name,r.workspace,r.trigger,r.due_at AS dueAt,
        r.queued_at AS queuedAt,r.started_at AS startedAt,r.finished_at AS finishedAt,r.status,r.detail,
        c.public_id AS sessionId
      FROM plan_runs r LEFT JOIN conversations c ON c.public_id=r.session_id
      ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
      ORDER BY r.queued_at DESC,r.id DESC LIMIT 51`).all(...params);
    const items = rows.slice(0, 50);
    const last = items.at(-1);
    return { items, cursor: rows.length > items.length ? { at: last.queuedAt, id: last.id } : null };
  }
}

module.exports = { PlanStore };
