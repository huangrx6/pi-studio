const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { getStudioDatabase, closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const { teamProject, teamCreateBot, teamCreateRoom, teamSetRoomBots } = require('../../electron/main/core/team-project.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-team-'));
  process.env.PI_STUDIO_DB = path.join(directory, 'test.sqlite');
  const first = path.join(directory, 'A');
  const second = path.join(directory, 'B');
  const studio = getStudioDatabase();
  for (const cwd of [first, second]) studio.upsertWorkspace({ cwd });
  t.after(() => {
    closeStudioDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { first, second, studio };
}

test('team rooms retain ordered membership across restarts and stay within their registered project', t => {
  const { first, second } = fixture(t);
  const engineer = teamCreateBot('  工程师  ');
  const reviewer = teamCreateBot('评审员');
  assert.equal(engineer.name, '工程师');
  const firstRoom = teamCreateRoom(first, '  评审  ');
  const secondRoom = teamCreateRoom(second, '评审');
  assert.notEqual(firstRoom.id, secondRoom.id);
  assert.deepEqual(secondRoom.botIds, []);
  const updated = teamSetRoomBots(first, firstRoom.id, [reviewer.id, engineer.id, reviewer.id]);
  assert.deepEqual(updated, { id: firstRoom.id, name: '评审', botIds: [reviewer.id, engineer.id] });
  assert.throws(() => teamSetRoomBots(second, firstRoom.id, []), /项目中没有这个群聊/);
  assert.throws(() => teamSetRoomBots(first, firstRoom.id, ['missing']), /Bot 成员已不存在/);

  closeStudioDatabase();
  const bots = [engineer, reviewer];
  assert.deepEqual(teamProject(), { bots, rooms: [] });
  assert.deepEqual(teamProject(first), { bots, rooms: [updated] });
  assert.deepEqual(teamProject(second), { bots, rooms: [secondRoom] });
  assert.deepEqual(teamSetRoomBots(first, firstRoom.id, []), firstRoom);
  assert.equal(getStudioDatabase().sessionWorkspace('room:' + firstRoom.id), first);
  assert.equal(getStudioDatabase().sessionWorkspace('room:' + secondRoom.id), second);
  assert.equal(getStudioDatabase().sessionWorkspace('room:' + first), null);
  assert.equal(getStudioDatabase().sessionWorkspace(firstRoom.id), null);

  getStudioDatabase().removeWorkspace(first);
  assert.equal(getStudioDatabase().sessionWorkspace('room:' + firstRoom.id), null);
  assert.throws(() => teamProject(first), /已登记的项目/);
  getStudioDatabase().upsertWorkspace({ cwd: first });
  assert.deepEqual(teamProject(first), { bots, rooms: [] });
  assert.deepEqual(teamProject(second), { bots, rooms: [secondRoom] });
});

test('team metadata rejects invalid names, unknown projects and malformed room members', t => {
  const { first } = fixture(t);
  for (const name of ['', ' ', 'a\nb', {}, 'a'.repeat(101)]) {
    assert.throws(() => teamCreateBot(name), /单行名称/);
    assert.throws(() => teamCreateRoom(first, name), /单行名称/);
  }
  assert.throws(() => teamCreateRoom(path.join(first, 'unregistered'), '房间'), /已登记的项目/);
  const room = teamCreateRoom(first, '房间');
  assert.throws(() => teamSetRoomBots(first, room.id, null), /有效的 Bot/);
  assert.throws(() => teamSetRoomBots(first, room.id, [null]), /有效的 Bot/);
  assert.deepEqual(teamProject(first), { bots: [], rooms: [room] });
});

test('an existing project gains empty team tables on upgrade', t => {
  const { first, studio } = fixture(t);
  studio.db.exec('DROP TABLE team_room_bots; DROP TABLE team_rooms; DROP TABLE team_bots; PRAGMA user_version = 28');
  closeStudioDatabase();
  assert.deepEqual(teamProject(first), { bots: [], rooms: [] });
  const room = teamCreateRoom(first, '默认工作区');
  assert.deepEqual(teamProject(first).rooms, [room]);
});
