const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '../../../..');
const directory = path.join(path.basename(root) === 'app.asar' ? root + '.unpacked' : root, 'assets/storyboard/web-sources');
const prefix = 'example:web-sources/';
const names = ['studio.jpg', 'before.png', 'after.png', 'dialog.png', 'voice-1.m4a', 'voice-2.m4a', 'voice-3.m4a', 'voice-4.m4a', 'click.wav'];

function sourcePath(stored) {
  if (!stored.startsWith(prefix)) return stored;
  const name = stored.slice(prefix.length);
  if (!names.includes(name)) throw new Error('未知的内置示例素材');
  return path.join(directory, name);
}

const scenes = [
  ['进入工作现场', '查看回答用到的网页。', 3000, 1710, 'push', 'cut'],
  ['旧版来源条', '以前，来源排在回答末尾。', 3500, 2590, 'push', 'dissolve'],
  ['点击地球按钮', '现在，点击回答底部的地球按钮。', 4000, 2350, 'push', 'cut'],
  ['展开网站列表', '所有来源集中在这里，点开即可阅读原文。', 4500, 3350, 'pull', 'dissolve'],
];

function seedExample(doc, link) {
  const labels = ['桌面开场', '旧版回答', '新版回答', '来源弹框'];
  doc.title = '网页来源 · 更新演示';
  doc.genre = 'product';
  doc.aspect = '16:9';
  for (const [i, name] of names.entries()) {
    const id = randomUUID();
    const stored = prefix + name;
    const label = labels[i] ?? (i === 8 ? '点击声' : '第 ' + (i - 3) + ' 镜旁白');
    doc.assets.push({ id, name: label + path.extname(name), kind: i < 4 ? 'image' : 'audio', size: fs.statSync(sourcePath(stored)).size });
    link(id, stored);
  }
  const ids = doc.assets.map(a => a.id);
  const idea = '演示怎样从回答底部打开网页来源，并查看原文。';
  const root = doc.nodes[0];
  root.answer = idea;
  root.assetIds = [...ids];
  const nodeId = randomUUID();
  const planId = randomUUID();
  const direction = { id: 'web-sources', title: '从回答末尾打开网页来源', beats: scenes.map(scene => scene[0]) };
  doc.nodes.push({ id: nodeId, parentId: root.id, kind: 'review', question: '用这份方案筹备分镜吗？', answer: '',
    chosenPlanId: planId, assetIds: [...ids], step: { brief: { idea, focus: '', genre: doc.genre, aspect: doc.aspect }, reply: direction.title, reason: '用同一段回答演示入口的变化。', direction } });
  doc.activeNodeId = nodeId;
  doc.approvedPlanId = planId;
  doc.plans.push({ id: planId, version: 1, nodeId, summary: idea, assetIds: [...ids] });
  const narration = { id: randomUUID(), role: 'narration', clips: [] };
  const effect = { id: randomUUID(), role: 'effect', clips: [] };
  scenes.forEach(([purpose, caption, durationMs, voiceMs, camera, transition], i) => {
    const id = randomUUID();
    const composition = { camera, transition };
    if (i === 0) composition.heading = '网页来源';
    if (i === 2) composition.pointer = { x: 100 / 1528, y: 383 / 426, atMs: 2450 };
    doc.shots.push({ id, planId, purpose, durationMs, assetIds: [ids[i]], framing: '', subjects: '', setting: '', motion: '',
      sound: '', composition, captions: [{ startMs: 200, endMs: durationMs - 180, text: caption }] });
    narration.clips.push({ shotId: id, assetId: ids[4 + i], offsetMs: 230, durationMs: voiceMs, gainDb: -2 });
    if (composition.pointer) effect.clips.push({ shotId: id, assetId: ids[8], offsetMs: composition.pointer.atMs, durationMs: 70, gainDb: -4 });
  });
  doc.tracks.push(narration, effect);
}

module.exports = { seedExample, sourcePath };
