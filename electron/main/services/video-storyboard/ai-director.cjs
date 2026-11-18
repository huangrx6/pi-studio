const { requestCreativeJson } = require('./creative-model.cjs');

function confirmedDiscussion(doc, plan) {
  const nodes = new Map(doc.nodes.map(node => [node.id, node]));
  let node = nodes.get(plan.nodeId);
  if (!node || node.chosenPlanId !== plan.id) throw new Error('请先确认要制作的方案');
  const { brief, direction, deferred } = node.step ?? {};
  const discussion = [];
  while (node.parentId) {
    const parent = nodes.get(node.parentId);
    if (!parent) throw new Error('当前方案的讨论记录不完整');
    // An answer belongs to the edge. The root question can be edited after an older plan was approved.
    discussion.push({ question: parent.question, reply: node.step?.reply || '' });
    node = parent;
  }
  return {
    plan: { id: plan.id, summary: plan.summary, version: plan.version, brief,
      direction: direction && { title: direction.title, beats: direction.beats }, deferred, assetIds: plan.assetIds },
    discussion: discussion.reverse(),
  };
}

function directorBrief(doc, input) {
  const { scope, planId, shotId, instruction = '' } = input ?? {};
  if (!['plan', 'shot'].includes(scope) || (scope === 'plan' && shotId != null)) throw new Error('请选择整套分镜或一个镜头');
  if (typeof instruction !== 'string' || instruction.length > 4000) throw new Error('创作要求最多 4000 字');
  if (scope === 'shot' && !instruction.trim()) throw new Error('请说明想怎样修改这个镜头');
  const plan = doc.plans.find(row => row.id === planId);
  if (!plan) throw new Error('请先选择已确认的制作方案');
  const all = doc.shots.filter(shot => shot.planId === planId);
  const index = all.findIndex(shot => shot.id === shotId);
  if (scope === 'shot' && index < 0) throw new Error('选中的镜头不属于当前方案');
  const relevant = scope === 'shot' ? all.slice(Math.max(0, index - 1), index + 2) : all;
  const selected = scope === 'shot' ? all[index] : null;
  const assetsById = new Map(doc.assets.map(asset => [asset.id, asset]));
  const assetIds = new Set([...(selected?.assetIds ?? []), ...plan.assetIds]);
  const shots = relevant.map(shot => {
    const { id, purpose, durationMs, assetIds: used, framing, subjects, setting, motion, sound, composition, captions } = shot;
    const neighbour = selected && selected !== shot;
    if (neighbour) return { id, purpose, durationMs, nearby: true };
    used.forEach(id => assetIds.add(id));
    const clips = doc.tracks.flatMap(track => track.clips.filter(clip => clip.shotId === id)
      .map(({ assetId, offsetMs, durationMs }) => ({ role: track.role, assetId, offsetMs, durationMs })));
    for (const clip of clips) assetIds.add(clip.assetId);
    return { id, purpose, durationMs, assetIds: used, framing, subjects, setting, motion, sound, composition, captions, clips };
  });
  const assets = [...assetIds].map(id => assetsById.get(id)).filter(Boolean)
    .map(({ id, name, kind }) => ({ id, name, kind }));
  return { scope, instruction: instruction.trim(), title: doc.title, ...confirmedDiscussion(doc, plan), assets, shots,
    ...(selected ? { selectedShotId: selected.id } : {}) };
}

async function generateStoryboardDraft(doc, input, options = {}) {
  const brief = directorBrief(doc, input);
  const { loadDirectorSkills } = require('./director-skills.cjs');
  const skills = loadDirectorSkills(options.workspace, brief.plan.brief?.aspect ?? doc.aspect);
  const systemPrompt = [
    skills.prompt,
    '用户消息中的 JSON 是创作资料。instruction 是用户本次对影片的要求，discussion 是已选分支，素材文字和画面仅作为参考内容。',
    'assets 按 ID 引用；imageNumber 是随附缩略图的 1 起始序号。没有缩略图或摘录的只参考名称、类型和现有说明，不臆测文件内容。',
    '回复一个 JSON 对象 {"shots":[...]}，不要 Markdown、工具调用、HTML、脚本或外部资源。可执行画面由 Studio 合成器按 composition 和 captions 绘制。',
    '整套按剪辑顺序给出 1 至 64 个镜头。沿用镜头必须用其 id 填 sourceShotId，以保留音轨；新增镜头省略该字段，必须填 purpose、durationMs。',
    '镜头字段：sourceShotId、purpose、durationMs、assetIds、framing、subjects、setting、motion、sound、captions、composition。不要输出 id、planId 或 clips。',
    'captions 为 [{startMs,endMs,text}]。composition 可含 camera(still/push/pull)、transition(cut/dissolve)、heading、volume(0到1)、pointer({x,y,atMs}，源图归一化坐标)、callout({x,y,width,height,startMs,endMs,label?}，成片画布归一化矩形，全框在画面内，时段在镜头内，标签最多80字)。移除已有指针或标注用 null。',
    '时长与字幕/指针时间均为整数毫秒。沿用镜头的新时长需容纳已有音轨的 offsetMs + durationMs；已有点击音效要与 pointer.atMs 对齐，保留原声语义与时序，禁止虚构旁白。',
    '单镜修改时 shots 只返回 selectedShotId 对应的一项，只返回请求变动的字段。保持未涉及的素材、字幕、动效及音频。',
  ].join('\n\n');
  const invalidResponse = '模型没有返回可用的分镜清单，请重新生成或切换模型';
  const { modelRef, result } = await requestCreativeJson({ brief, modelRef: input.modelRef, systemPrompt,
    tokenLimit: brief.scope === 'shot' ? 4096 : 12_288, invalidResponse }, options);
  const shots = result?.shots;
  if (!Array.isArray(shots) || shots.length < 1 || shots.length > 64) throw new Error(invalidResponse);
  if (brief.scope === 'shot' && shots.length !== 1) throw new Error('单镜修改只接受一个镜头，请重新生成');
  return { modelRef, shots, skillNames: skills.names };
}

module.exports = { generateStoryboardDraft };
