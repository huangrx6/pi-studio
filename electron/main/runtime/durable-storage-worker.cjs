const { parentPort, workerData } = require('node:worker_threads');

async function listen() {
  const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  let storage;
  parentPort.on('message', async ({ id, method, args }) => {
    try {
      let value;
      if (method === 'open') {
        storage = await openNodeSqliteStorage(workerData.filename, workerData.options);
      } else if (method === 'commit') {
        const receipts = [];
        const result = await storage.commit(args[0], (index, seq) => receipts.push([index, seq]), BACKGROUND_CONTEXT);
        value = { receipts, result };
      } else {
        value = await storage[method](...args, BACKGROUND_CONTEXT);
      }
      parentPort.postMessage({ id, value });
    } catch (error) {
      const { name, message, stack, code, errcode } = error;
      parentPort.postMessage({ id, error: { name, message, stack, code, errcode } });
    }
  });
}

listen().catch(error => { process.nextTick(() => { throw error; }); });
