const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { getStudioDatabase } = require('./studio-db.cjs');

function teamName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 100 || /[\x00-\x1f\x7f]/u.test(name)) {
    throw new Error('请输入 1 至 100 个字符的单行名称');
  }
  return name;
}

function requireProject(studio, cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !studio.getWorkspace(cwd)) {
    throw new Error('请选择已登记的项目');
  }
}

function teamProject(cwd) {
  const studio = getStudioDatabase();
  return studio.transaction(() => {
    const bots = studio.db.prepare('SELECT id, name FROM team_bots ORDER BY rowid').all()
      .map(({ id, name }) => ({ id, name }));
    if (cwd === undefined || cwd === '') return { bots, rooms: [] };
    requireProject(studio, cwd);
    const rows = studio.db.prepare(`
      SELECT room.id, room.name, member.bot_id
        FROM team_rooms room LEFT JOIN team_room_bots member ON member.room_id = room.id
       WHERE room.workspace = ?
       ORDER BY room.rowid, member.position
    `).all(cwd);
    const rooms = [];
    for (const row of rows) {
      if (rooms.at(-1)?.id !== row.id) rooms.push({ id: row.id, name: row.name, botIds: [] });
      if (row.bot_id !== null) rooms.at(-1).botIds.push(row.bot_id);
    }
    return { bots, rooms };
  }, { deferred: true });
}

function teamCreateBot(value) {
  const bot = { id: randomUUID(), name: teamName(value) };
  getStudioDatabase().db.prepare('INSERT INTO team_bots(id, name) VALUES (?, ?)').run(bot.id, bot.name);
  return bot;
}

function teamCreateRoom(cwd, value) {
  const room = { id: randomUUID(), name: teamName(value), botIds: [] };
  const studio = getStudioDatabase();
  return studio.transaction(() => {
    requireProject(studio, cwd);
    studio.db.prepare('INSERT INTO team_rooms(id, workspace, name) VALUES (?, ?, ?)').run(room.id, cwd, room.name);
    return room;
  });
}

function teamSetRoomBots(cwd, roomId, botIds) {
  if (typeof roomId !== 'string' || !roomId) throw new Error('请选择项目中的群聊');
  if (!Array.isArray(botIds) || botIds.some(id => typeof id !== 'string' || !id)) {
    throw new Error('请选择有效的 Bot 成员');
  }
  const members = [...new Set(botIds)];
  const studio = getStudioDatabase();
  return studio.transaction(() => {
    requireProject(studio, cwd);
    const room = studio.db.prepare('SELECT name FROM team_rooms WHERE id = ? AND workspace = ?').get(roomId, cwd);
    if (!room) throw new Error('项目中没有这个群聊');
    const find = studio.db.prepare('SELECT id FROM team_bots WHERE id = ?');
    if (members.some(id => !find.get(id))) throw new Error('所选 Bot 成员已不存在');
    studio.db.prepare('DELETE FROM team_room_bots WHERE room_id = ?').run(roomId);
    const add = studio.db.prepare('INSERT INTO team_room_bots(room_id, bot_id, position) VALUES (?, ?, ?)');
    members.forEach((id, position) => add.run(roomId, id, position));
    return { id: roomId, name: room.name, botIds: members };
  });
}

module.exports = { teamProject, teamCreateBot, teamCreateRoom, teamSetRoomBots };
