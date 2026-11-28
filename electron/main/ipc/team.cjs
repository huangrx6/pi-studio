const { ipcMain } = require('electron');
const { teamProject, teamCreateBot, teamCreateRoom, teamSetRoomBots } = require('../core/team-project.cjs');

function registerTeamIpc() {
  ipcMain.handle('pi:team-project', (_event, cwd) => teamProject(cwd));
  ipcMain.handle('pi:team-create-bot', (_event, name) => teamCreateBot(name));
  ipcMain.handle('pi:team-create-room', (event, cwd, name) => {
    const room = teamCreateRoom(cwd, name);
    event.sender.send('pi:conversation-list-changed');
    return room;
  });
  ipcMain.handle('pi:team-set-room-bots', (_event, cwd, roomId, botIds) => teamSetRoomBots(cwd, roomId, botIds));
}

module.exports = { registerTeamIpc };
