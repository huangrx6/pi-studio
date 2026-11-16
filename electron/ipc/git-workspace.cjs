/**
 * IPC：当前工作区的 Git 状态。
 *
 * Git 操作使用主进程记录的会话工作目录。
 */

const path = require('node:path');
const { realpath } = require('node:fs/promises');
const { ipcMain, shell } = require('electron');
const { getWindow, DEFAULT_CWD } = require('../core/state.cjs');
const { manageWorktree, contains } = require('../services/git-worktrees.cjs');
const { getGitWorkspaceStatus } = require('../services/git-workspace.cjs');
const { gitRead, gitWrite } = require('../services/git-tools.cjs');
const { getStudioDatabase } = require('../core/studio-db.cjs');

function assertMainWindow(event) {
  const window = getWindow();
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('拒绝来自非主窗口的 Git 状态请求');
  }
}

function registerGitWorkspaceIpc() {
  for (const [channel, handler] of [['pi:git-read', gitRead], ['pi:git-write', gitWrite]]) {
    ipcMain.handle(channel, async (event, sessionId, input) => {
      assertMainWindow(event);
      if (typeof sessionId !== 'string') throw new Error('请选择会话。');
      const cwd = getStudioDatabase().getConversation(sessionId)?.workspace;
      if (!cwd) throw new Error('找不到会话工作区。');
      return handler(cwd, input);
    });
  }
  ipcMain.handle('pi:git-workspace-status', async (event, cwd) => {
    assertMainWindow(event);
    return getGitWorkspaceStatus(typeof cwd === 'string' ? cwd : '');
  });
  ipcMain.handle('pi:git-worktree', async (event, cwd, input) => {
    assertMainWindow(event);
    const db = getStudioDatabase();
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || (cwd !== DEFAULT_CWD && !db.getWorkspace(cwd))) {
      throw new Error('请选择已打开的工作区。');
    }
    const result = await manageWorktree(cwd, input, {
      trashItem: target => shell.trashItem(target),
      assertUnused: async target => {
        if (db.listManagedWorktrees({ includeTerminal: true }).some(record => contains(target, record.path))) {
          throw new Error('此目录包含子智能体管理的工作树，请在子智能体设置中处理。');
        }
        const { listWorkspaces } = require('../runtime/conversations.cjs');
        const groups = await listWorkspaces();
        for (const group of groups.filter(group => group.sessions.some(session => session.running))) {
          if (contains(target, await realpath(group.cwd).catch(() => group.cwd))) {
            throw new Error('此工作树中仍有会话运行，请等它结束后再移除。');
          }
        }
      },
    });
    if (input.kind === 'open') db.upsertWorkspace({ cwd: result, hidden: false });
    if (input.kind === 'remove' && db.getWorkspace(input.path)) {
      db.upsertWorkspace({ cwd: input.path, hidden: true });
      event.sender.send('pi:conversation-list-changed');
    }
    return result;
  });
}

module.exports = { registerGitWorkspaceIpc };
