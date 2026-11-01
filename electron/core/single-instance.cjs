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
    app.quit();
    return false;
  }

  app.on('second-instance', (_event, argv, workingDirectory) => {
    onSecondInstance?.({ argv, workingDirectory });
  });
  return true;
}

module.exports = { installSingleInstanceGuard };
