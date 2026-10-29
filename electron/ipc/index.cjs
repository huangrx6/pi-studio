/**
 * IPC 注册入口。
 *
 * 每个域一个文件，这里只负责汇总，方便一眼看清主进程暴露了哪些能力：
 *  - system       主题、首屏状态
 *  - sessions     会话、消息、侧边栏
 *  - files        文件浏览、外部打开
 *  - attachments  附件
 *  - models       模型、提供方、API Key
 *  - usage        本地 Token 用量与模型分布
 *  - settings     MCP、技能、扩展、包
 *  - updates      GitHub Release 检查、下载与安装
 */

const { registerSystemIpc } = require('./system.cjs');
const { registerConversationIpc } = require('./sessions.cjs');
const { registerFilesIpc } = require('./files.cjs');
const { registerAttachmentsIpc } = require('./attachments.cjs');
const { registerModelsIpc } = require('./models.cjs');
const { registerUsageIpc } = require('./usage.cjs');
const { registerSettingsIpc } = require('./settings.cjs');
const { registerModeIpc } = require('./mode.cjs');
const { registerTemporaryChatIpc } = require('./temporary-chat.cjs');
const { registerConfirmIpc } = require('./confirm.cjs');
const { registerUpdatesIpc } = require('./updates.cjs');

function registerIpc() {
  registerSystemIpc();
  registerConversationIpc();
  registerFilesIpc();
  registerAttachmentsIpc();
  registerModelsIpc();
  registerUsageIpc();
  registerSettingsIpc();
  registerModeIpc();
  registerTemporaryChatIpc();
  registerConfirmIpc();
  registerUpdatesIpc();
}

module.exports = { registerIpc };
