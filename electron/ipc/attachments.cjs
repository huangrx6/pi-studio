/**
 * IPC：附件。
 * 系统文件选择、拖拽上传保存、超长消息转附件。
 */

const { ipcMain } = require('electron');
const { pickAttachments, saveUpload, saveAttachment } = require('../services/attachments.cjs');

function registerAttachmentsIpc() {
  // 打开文件选择框，返回可直接发送的附件
  ipcMain.handle('pi:pick-attachments', async (_event, payload) => pickAttachments(payload || {}));

  // 保存拖拽上传的文件（base64）
  ipcMain.handle('pi:save-upload', async (_event, payload) => saveUpload(payload || {}));

  // 超长消息保存为附件
  ipcMain.handle('pi:save-attachment', async (_event, payload) => saveAttachment(payload || {}));
}

module.exports = { registerAttachmentsIpc };
