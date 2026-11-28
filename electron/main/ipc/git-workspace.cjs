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
const { listGitRepositories, resolveGitRepository } = require('../services/git-repositories.cjs');
const { gitRead, gitWrite, listGitChanges } = require('../services/git-tools.cjs');
const { getStudioDatabase } = require('../core/studio-db.cjs');

function assertMainWindow(event) {
  const window = getWindow();
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('拒绝来自非主窗口的 Git 状态请求');
  }
}

function registerGitWorkspaceIpc() {
  function checkWorkspace(cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || (cwd !== DEFAULT_CWD && !getStudioDatabase().getWorkspace(cwd))) {
      throw new Error('请选择已打开的工作区。');
    }
  }
  ipcMain.handle('pi:git-repositories', (event, cwd) => {
    assertMainWindow(event);
    checkWorkspace(cwd);
    return listGitRepositories(cwd);
  });
  ipcMain.handle('pi:git-workspace-changes', async (event, cwd, repository) => {
    assertMainWindow(event);
    checkWorkspace(cwd);
    return listGitChanges(await resolveGitRepository(cwd, repository));
  });
  ipcMain.handle('pi:git-branches', (event, cwd, repository) => {
    assertMainWindow(event);
    checkWorkspace(cwd);
    return gitRead(cwd, { kind: 'branches', repository });
  });
  ipcMain.handle('pi:git-checkout', async (event, cwd, input) => {
    assertMainWindow(event);
    checkWorkspace(cwd);
    if (!['create', 'switch'].includes(input?.kind)) throw new Error('请选择分支操作。');
    await gitWrite(cwd, input);
    event.sender.send('pi:conversation-list-changed');
  });
  for (const [channel, handler] of [['pi:git-read', gitRead], ['pi:git-write', gitWrite]]) {
    ipcMain.handle(channel, async (event, sessionId, input) => {
      assertMainWindow(event);
      if (typeof sessionId !== 'string') throw new Error('请选择会话。');
      const cwd = getStudioDatabase().sessionWorkspace(sessionId);
      if (!cwd) throw new Error('找不到会话工作区。');
      if (['branches', 'create', 'switch'].includes(input?.kind)) throw new Error('请通过工作树选择分支。');
      return handler(cwd, input);
    });
  }
  ipcMain.handle('pi:git-workspace-status', async (event, cwd, repository) => {
    assertMainWindow(event);
    if (repository && repository !== '.') {
      checkWorkspace(cwd);
      return getGitWorkspaceStatus(await resolveGitRepository(cwd, repository));
    }
    return getGitWorkspaceStatus(typeof cwd === 'string' ? cwd : '');
  });
  ipcMain.handle('pi:git-worktree', async (event, cwd, input) => {
    assertMainWindow(event);
    const db = getStudioDatabase();
    checkWorkspace(cwd);
    const root = await resolveGitRepository(cwd, input.repository);
    const result = await manageWorktree(root, input, {
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
    if (input.kind === 'create' || input.kind === 'open') {
      db.upsertWorkspace({ cwd: result, hidden: false });
      event.sender.send('pi:conversation-list-changed');
    }
    if (input.kind === 'remove' && db.getWorkspace(input.path)) {
      db.upsertWorkspace({ cwd: input.path, hidden: true });
      event.sender.send('pi:conversation-list-changed');
    }
    return result;
  });
}

module.exports = { registerGitWorkspaceIpc };
