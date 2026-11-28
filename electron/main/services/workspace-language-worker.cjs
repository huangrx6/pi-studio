const { Worker, isMainThread, parentPort } = require('node:worker_threads');

if (!isMainThread) {
  const { queryWorkspaceLanguage } = require('./workspace-language.cjs');
  parentPort.on('message', ({ id, request }) => {
    try { parentPort.postMessage({ id, value: queryWorkspaceLanguage(request) }); }
    catch (error) { parentPort.postMessage({ id, error: error.message }); }
  });
}

let worker, idle, sequence = 0;
const pending = new Map();
function query(request) {
  clearTimeout(idle);
  if (!worker) {
    const current = new Worker(__filename, { execArgv: [] });
    worker = current;
    function disconnect(error) {
      if (worker !== current) return;
      worker = undefined;
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    }
    current.on('error', disconnect);
    current.on('exit', () => disconnect(new Error('项目语言服务已关闭')));
    current.on('message', ({ id, value, error }) => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (error) entry.reject(new Error(error));
      else entry.resolve(value);
      if (!pending.size) idle = setTimeout(() => { worker = undefined; void current.terminate(); }, 60_000).unref();
    });
    current.unref();
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, request });
  });
}
module.exports = { query };
