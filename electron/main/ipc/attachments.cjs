/**
 * IPC：附件。
 * 系统文件选择、拖拽上传保存、超长消息转附件。
 */

const { ipcMain } = require('electron');
const {
  pickAttachments,
  saveUpload,
  saveAttachment,
  readAttachmentFile,
} = require('../services/attachments.cjs');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const { conversationAvailable } = require('../runtime/conversations.cjs');
const { copyImageToClipboard } = require('../services/image-clipboard.cjs');
const { copyTextAndHtml } = require('../services/rich-clipboard.cjs');
const { getWindow } = require('../core/state.cjs');

function assertMainWindow(event) {
  const window = getWindow();
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error('拒绝来自非主窗口的附件请求');
  }
}

function uploadPayload(payload) {
  const id = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  if (!id || id === 'draft') return { ...payload, sessionId: 'draft' };
  const owner = getStudioDatabase().getConversation(id);
  if (!owner || !conversationAvailable(owner.id)) throw new Error('会话不存在或正在删除');
  return { ...payload, sessionId: owner };
}

function registerAttachmentsIpc() {
  // 打开文件选择框，返回可直接发送的附件
  ipcMain.handle('pi:pick-attachments', async (event, payload) => {
    assertMainWindow(event);
    return pickAttachments(payload || {}, () => uploadPayload(payload).sessionId);
  });

  // 保存拖拽上传的文件（base64）
  ipcMain.handle('pi:save-upload', async (event, payload) => {
    assertMainWindow(event);
    return saveUpload(uploadPayload(payload));
  });

  // 超长消息保存为附件
  ipcMain.handle('pi:save-attachment', async (event, payload) => {
    assertMainWindow(event);
    return saveAttachment(uploadPayload(payload));
  });

  // 只读预览 Studio 自己管理的附件，不接受任意绝对路径。
  ipcMain.handle('pi:attachment-file', async (event, payload) => {
    assertMainWindow(event);
    return readAttachmentFile(payload || {});
  });

  // 把消息或输入框中的内联图片写入系统剪贴板
  ipcMain.handle('pi:copy-image', async (event, payload) => {
    assertMainWindow(event);
    return await copyImageToClipboard(payload?.src);
  });

  // 复制消息：正文与图片以纯文本 + 富文本两种形式同时写入剪贴板
  ipcMain.handle('pi:copy-rich-text', async (event, payload) => {
    assertMainWindow(event);
    return await copyTextAndHtml(payload || {});
  });
}

module.exports = { registerAttachmentsIpc };
