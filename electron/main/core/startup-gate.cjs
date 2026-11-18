/**
 * Gate workspace access and activation behind successful initialization.
 *
 * macOS may emit `activate` or `second-instance` before Durable is ready. Those
 * requests are remembered while the window displays the launch screen.
 */
function createStartupGate({
  initialize,
  ready,
  failed,
  report = console.error,
}) {
  let status = 'idle';
  let requestedBeforeReady = false;
  let promise;

  async function run() {
    try {
      await initialize();
      if (status !== 'starting') return;
      status = 'ready';
      await ready({ requestedBeforeReady });
    } catch (error) {
      status = 'failed';
      try {
        await failed(error);
      } catch (failureError) {
        report('[pi-studio] startup failure handler failed', failureError);
      }
    }
  }

  function start() {
    if (promise) return promise;
    if (status !== 'idle') return Promise.resolve(status === 'ready');
    status = 'starting';
    promise = run();
    return promise;
  }

  function requestReveal() {
    if (status === 'ready') return true;
    if (status === 'starting') requestedBeforeReady = true;
    return false;
  }

  return {
    get status() {
      return status;
    },
    get requestedBeforeReady() {
      return requestedBeforeReady;
    },
    requestReveal,
    start,
  };
}

module.exports = { createStartupGate };
