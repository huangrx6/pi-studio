const { ipcMain } = require('electron');
const { planScheduler } = require('../services/plan-scheduler.cjs');

function registerPlanIpc() {
  ipcMain.handle('pi:plan-list', () => planScheduler().store.listPlans());
  ipcMain.handle('pi:plan-week', (_event, boundaries) => planScheduler().store.week(boundaries, Date.now()));
  ipcMain.handle('pi:plan-history', (_event, cursor, planId) => planScheduler().store.history(cursor, planId));
  ipcMain.handle('pi:plan-preview', (_event, rule, id) => planScheduler().store.preview(rule, id, Date.now()));
  ipcMain.handle('pi:plan-save', (_event, input) => {
    const scheduler = planScheduler();
    const id = scheduler.store.save(input, Date.now());
    scheduler.tick();
    scheduler.notify();
    return id;
  });
  ipcMain.handle('pi:plan-action', (_event, action, id) => {
    if (typeof id !== 'string' || !id) throw new Error('请选择计划或运行记录');
    const scheduler = planScheduler();
    const now = Date.now();
    switch (action) {
      case 'run': scheduler.store.runNow(id, now); break;
      case 'pause': case 'resume': scheduler.store.setPaused(id, action === 'pause', now); break;
      case 'delete': scheduler.store.remove(id); break;
      case 'stop': scheduler.cancel(id); break;
      default: throw new Error('未知的计划操作');
    }
    scheduler.tick();
    scheduler.notify();
  });
}

module.exports = { registerPlanIpc };
