const { ipcMain } = require('electron');
const { temporaryModel, temporaryPrompt, stopTemporary, closeTemporary, closeOwner } = require('../services/temporary-chat.cjs');
function registerTemporaryChatIpc() {
  const owners = new Set();
  ipcMain.handle('pi:temporary-model', (_event, payload) => temporaryModel(payload));
  ipcMain.handle('pi:temporary-prompt', async (event, payload) => {
    const owner = event.sender.id;
    if (!owners.has(owner)) { owners.add(owner); event.sender.once('destroyed', () => { owners.delete(owner); closeOwner(owner); }); }
    const send = data => { if (!event.sender.isDestroyed()) event.sender.send('pi:temporary-event', { id: payload.id, ...data }); };
    await temporaryPrompt(owner, payload, send);
    return { ok: true };
  });
  ipcMain.handle('pi:temporary-stop', (event, id) => stopTemporary(event.sender.id, id));
  ipcMain.handle('pi:temporary-close', (event, id) => closeTemporary(event.sender.id, id));
}
module.exports = { registerTemporaryChatIpc };
