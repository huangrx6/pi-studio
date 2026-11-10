/**
 * Keep one Studio main process per profile.
 *
 * A second launch must hand focus back to the existing process. Letting two
 * mains initialize the same SQLite database and Chromium profile can leave a
 * renderer attached to a partially initialized application.
 */
function installSingleInstanceGuard(app, onSecondInstance) {
  const primary = app.requestSingleInstanceLock();
  if (!primary) {
    // 同一份 userData 只能有一个主进程。开发实例与安装版共用目录时，
    // 后来的那个会以退出码 0 静默结束，看起来像「启动就退出」，
    // 所以这里必须留下一行可见原因。
    const profile = app.getPath?.('userData');
    console.warn(`[pi-studio] 另一个 Pi Studio 正在使用这份应用数据，本次启动退出。数据目录：${profile ?? '未知'}`);
    app.quit();
    return false;
  }

  app.on('second-instance', (_event, argv, workingDirectory) => {
    onSecondInstance?.({ argv, workingDirectory });
  });
  return true;
}

module.exports = { installSingleInstanceGuard };
