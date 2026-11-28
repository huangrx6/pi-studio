/**
 * IPC 注册入口。
 *
 * 每个域一个文件，这里只负责汇总，方便一眼看清主进程暴露了哪些能力：
 *  - system       主题、首屏状态
 *  - sessions     会话、消息、侧边栏
 *  - team         Bot 成员库与项目房间
 *  - plans        项目计划、执行时间预览与运行记录
 *  - files        文件浏览、外部打开
 *  - attachments  附件
 *  - models       模型、提供方、API Key
 *  - usage        本地 Token 用量与模型分布
 *  - settings     MCP、技能、扩展、包
 *  - updates      GitHub Release 检查、下载与安装
 *  - terminal     每个窗口独占的交互式 PTY 会话
 *  - runtime-services 只读监听端口与服务进程发现
 *  - git-workspace 当前目录的 Git 分支、提交、改动与 worktree
 *  - browser       内嵌浏览器下载与站点数据
 *  - desktop-control macOS 电脑操控设置、权限与活动日志
 */

const { registerSystemIpc } = require('./system.cjs');
const { registerNetworkIpc } = require('./network.cjs');
const { registerConversationIpc } = require('./sessions.cjs');
const { registerTeamIpc } = require('./team.cjs');
const { registerPlanIpc } = require('./plans.cjs');
const { registerFilesIpc } = require('./files.cjs');
const { registerAttachmentsIpc } = require('./attachments.cjs');
const { registerModelsIpc } = require('./models.cjs');
const { registerUsageIpc } = require('./usage.cjs');
const { registerSettingsIpc } = require('./settings.cjs');
const { registerModeIpc } = require('./mode.cjs');
const { registerTemporaryChatIpc } = require('./temporary-chat.cjs');
const { registerConfirmIpc } = require('./confirm.cjs');
const { registerUpdatesIpc } = require('./updates.cjs');
const { registerTerminalIpc } = require('./terminal.cjs');
const { registerRuntimeServicesIpc } = require('./runtime-services.cjs');
const { registerGitWorkspaceIpc } = require('./git-workspace.cjs');

const { registerBrowserIpc } = require('./browser.cjs');
const { registerDesktopControlIpc } = require('./desktop-control.cjs');

function registerIpc(waitForStartup) {
  registerSystemIpc(waitForStartup);
  registerNetworkIpc(waitForStartup);
  registerConversationIpc();
  registerTeamIpc();
  registerPlanIpc();
  registerFilesIpc();
  registerAttachmentsIpc();
  registerModelsIpc();
  registerUsageIpc();
  registerSettingsIpc();
  registerModeIpc();
  registerTemporaryChatIpc();
  registerConfirmIpc();
  registerUpdatesIpc();
  registerTerminalIpc();
  registerRuntimeServicesIpc();
  registerGitWorkspaceIpc();
  registerBrowserIpc();
  registerDesktopControlIpc();
}

module.exports = { registerIpc };
