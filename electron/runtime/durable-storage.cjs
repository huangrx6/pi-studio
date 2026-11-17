// Studio's synchronous projections and Durable's asynchronous transactions share a WAL file.
// The connection that owns an open Durable transaction must be able to COMMIT even while
// the Electron main thread is waiting for that file's write lock.
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const reads = [
  'conversation', 'scanConversations', 'entry', 'findLatestHeadMarker', 'scanEntries',
  'task', 'scanTasks', 'submission', 'scanSubmissions', 'submissionByRequest',
  'findDocument', 'document', 'scanDocuments',
];

async function openDurableStorage(filename, options) {
  const { StorageRequestError } = await import('@earendil-works/pi-durable');
  const worker = new Worker(path.join(__dirname, 'durable-storage-worker.cjs'), {
    execArgv: [],
    workerData: { filename, options },
  });
  const pending = new Map();
  let nextId = 0;
  let stopped;
  let closing;
  let committing = Promise.resolve();

  function stop(error) {
    stopped = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  worker.on('error', stop);
  worker.on('exit', code => stop(stopped || new Error('Durable SQLite worker exited (' + code + ')')));
  worker.on('message', ({ id, value, error }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (pending.size === 0) worker.unref();
    if (!error) { request.resolve(value); return; }
    // The harness distinguishes a bad read request from a fatal storage failure by instanceof.
    const reason = error.name === 'StorageRequestError' ? new StorageRequestError(error.message) : new Error(error.message);
    request.reject(Object.assign(reason, error));
  });
  function request(method, args) {
    if (stopped) return Promise.reject(stopped);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      worker.ref();
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, method, args }); }
      catch (error) {
        pending.delete(id);
        if (pending.size === 0) worker.unref();
        reject(error);
      }
    });
  }
  try { await request('open', []); }
  catch (error) { await worker.terminate(); throw error; }

  const closed = () => Promise.reject(new Error('Durable SQLite storage is closed'));
  return {
    // Context contains non-transferable handles. This SQLite driver ignores it, including
    // for cancelled reads. Supply the driver's own background context inside the worker.
    ...Object.fromEntries(reads.map(method => [method, (...args) =>
      closing ? closed() : request(method, args.slice(0, -1))])),
    mintId: () => closing ? closed() : request('mintId', []),
    commit(batches, receive) {
      if (closing) return closed();
      const result = committing.then(async () => {
        const { receipts, result } = await request('commit', [batches]);
        for (const [index, seq] of receipts) receive(index, seq);
        return result;
      });
      committing = result.catch(() => {});
      return result;
    },
    close() {
      closing ??= committing.then(() => request('close', [])).finally(() => worker.terminate());
      return closing;
    },
  };
}

module.exports = { openDurableStorage };
