const { PlanStore } = require('../core/plan-store.cjs');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const { getWindow } = require('../core/state.cjs');

const RUN_LIMIT_MS = 60 * 60 * 1000;
const TIMEOUT_REASON = '运行超过 60 分钟，已停止';
const MAX_DELAY = 2 ** 31 - 1;

class PlanScheduler {
  constructor({ store, execute, notify = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { store, execute, notify, now, setTimer, clearTimer });
    this.started = false;
    this.holds = 0;
    this.alarm = null;
    this.active = null;
  }

  start() {
    this.started = true;
    this.tick();
  }

  arm(delay) {
    this.alarm = this.setTimer(() => this.tick(), Math.max(0, Math.min(MAX_DELAY, delay)));
    this.alarm?.unref?.();
  }

  tick() {
    this.clearTimer(this.alarm);
    this.alarm = null;
    if (!this.started) return;
    try {
      const now = this.now();
      if (this.store.collectDue(now)) this.notify();
      if (!this.active && !this.holds) {
        const run = this.store.claim(now);
        if (run) this.launch(run);
      }
      if (this.active && !this.active.controller.signal.aborted && this.active.deadline <= now) {
        this.cancel(this.active.id, TIMEOUT_REASON);
      }
      const deadline = this.active && !this.active.controller.signal.aborted ? this.active.deadline : Infinity;
      const next = Math.min(this.store.nextAlarm() ?? Infinity, deadline);
      if (Number.isFinite(next)) this.arm(next - this.now());
    } catch (error) {
      console.error('[pi-studio] 无法读取计划调度状态', error);
      this.arm(30000);
    }
  }

  launch(run) {
    const controller = new AbortController();
    if (run.stop_reason) controller.abort(new Error(run.stop_reason));
    const active = { id: run.id, workspace: run.workspace, deadline: run.started_at + RUN_LIMIT_MS, controller };
    this.active = active;
    active.done = Promise.resolve().then(async () => {
      let status, detail;
      try {
        ({ status, detail } = await this.execute(run, {
          signal: controller.signal,
          bindSession: id => this.store.bindSession(run.id, id),
        }));
        if (status === 'cancelled' && controller.signal.aborted) {
          detail = controller.signal.reason.message;
          if (detail === TIMEOUT_REASON) status = 'failed';
        }
      } catch (error) {
        const reason = controller.signal.reason?.message;
        status = reason && reason !== TIMEOUT_REASON ? 'cancelled' : 'failed';
        detail = reason || error?.message || '计划执行失败';
      }
      this.store.finish(run.id, status, detail, this.now());
    }).then(() => {
      this.active = null;
      this.notify();
      this.tick();
    }).catch(error => {
      this.active = null;
      this.clearTimer(this.alarm);
      this.alarm = null;
      console.error('[pi-studio] 无法保存计划运行结果', error);
      if (this.started) this.arm(30000);
    });
    this.notify();
  }

  cancel(id, reason = '用户已停止执行') {
    this.store.requestStop(id, reason, this.now());
    if (this.active?.id === id) this.active.controller.abort(new Error(reason));
    this.notify();
  }

  async removingWorkspace(cwd, remove) {
    this.holds++;
    try {
      if (this.active?.workspace === cwd) {
        this.cancel(this.active.id, '项目已移除');
        await this.active.done;
      }
      return await remove();
    } finally {
      this.holds--;
      this.notify();
      this.tick();
    }
  }

  async stop() {
    this.started = false;
    this.clearTimer(this.alarm);
    this.alarm = null;
    if (this.active) {
      this.cancel(this.active.id, '应用已退出，本次运行已停止');
      await this.active.done;
    }
  }
}

let scheduler, monitor, resume;
function startPlanScheduler(powerMonitor) {
  if (scheduler) return;
  const { executePlanRun } = require('../runtime/plan-run.cjs');
  let changePending = false;
  scheduler = new PlanScheduler({
    store: new PlanStore(getStudioDatabase()), execute: executePlanRun,
    notify() {
      if (changePending) return;
      changePending = true;
      queueMicrotask(() => {
        changePending = false;
        const win = getWindow();
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('pi:plans-changed');
      });
    },
  });
  monitor = powerMonitor;
  resume = () => scheduler?.tick();
  monitor.on('resume', resume);
  scheduler.start();
}

function planScheduler() {
  if (!scheduler?.started) throw new Error('计划服务尚未就绪');
  return scheduler;
}

async function stopPlanScheduler() {
  monitor?.removeListener('resume', resume);
  monitor = resume = undefined;
  const current = scheduler;
  scheduler = undefined;
  await current?.stop();
}

module.exports = { PlanScheduler, planScheduler, startPlanScheduler, stopPlanScheduler };
