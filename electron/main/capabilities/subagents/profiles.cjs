const { randomUUID } = require('node:crypto');
const { getStudioDatabase } = require('../../core/studio-db.cjs');
const { getHarnessProfile, getHarnessStore, getSubagentConfig } = require('../../core/app-settings.cjs');
const { normalizeRoleOverrides, resolveRoleDefaults, SUBAGENT_TOOL_NAMES } = require('../../core/subagent-config.cjs');
const { discoverSkills, skillReferenceId } = require('../skills/index.cjs');
const { avatarCatalog } = require('./avatars.cjs');

// This library belongs to the Studio user. Project resources are resolved again
// in the invoking workspace, using the permissions effective for that request.
const LIBRARY_KEY = 'studio.subagentProfiles.v1';
const inherited = { model: '', mcpServers: null, skills: null, harnessId: '', revision: 1 };
const starters = [
  { ...inherited, id: '81a1c938-91b8-4a09-9622-ae1b2ec32ef5', name: '代码审阅', avatarId: 'indigo-bob',
    description: '检查改动中的行为回归，给出可复现的验证步骤。',
    instructions: '按影响程度列出发现，注明相关文件、触发条件和验证方法。' },
  { ...inherited, id: 'b9afc879-f3c5-4885-b967-4af779a3c164', name: '资料研究', avatarId: 'sage-braid',
    description: '查阅项目文档与外部资料，整理可以追溯的结论。',
    instructions: '优先查阅一手材料，标注来源，并区分直接证据与推断。' },
];

function listSubagentProfiles() {
  return getStudioDatabase().getSetting(LIBRARY_KEY, structuredClone(starters))
    .map(row => ({ runtimeOverrides: {}, ...row }));
}

function textField(value, label, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new Error(`请检查${label}，最多 ${limit} 个字符`);
  }
  return value.trim();
}

// null inherits, [] explicitly offers none. Never turn an invalid selection into inheritance.
function resourceList(value, label) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${label}选择无效`);
  return [...new Set(value.map(item => textField(item, label, 256, true)))];
}

function existingProfile(profiles, id, revision) {
  const profile = profiles.find(row => row.id === id);
  if (!profile) throw new Error('这个子智能体已被删除，请重新选择');
  if (profile.revision !== revision) throw new Error('角色配置已经更新，请重新打开编辑');
  return profile;
}

function saveSubagentProfile(input = {}) {
  const db = getStudioDatabase();
  return db.transaction(() => {
    const profiles = listSubagentProfiles();
    const prior = input.id ? existingProfile(profiles, input.id, input.revision) : null;
    if (!Object.hasOwn(avatarCatalog, input.avatarId)) throw new Error('请选择一个内置头像');
    const model = textField(input.model, '模型', 256);
    if (model && model !== 'parent' && !/^[^\s/]+\/.+$/u.test(model)) throw new Error('请选择有效的模型');
    const name = textField(input.name, '名称', 48, true);
    if (/[\r\n\t]/u.test(name)) throw new Error('角色名称须在一行内');
    const next = {
      id: prior?.id ?? randomUUID(),
      revision: (prior?.revision || 0) + 1,
      name, avatarId: input.avatarId, model,
      description: textField(input.description, '职责描述', 180, true),
      instructions: textField(input.instructions, '角色指令', 16000),
      mcpServers: resourceList(input.mcpServers, 'MCP 服务'),
      skills: resourceList(input.skills, '技能'),
      harnessId: textField(input.harnessId, 'Harness 配置', 128),
      runtimeOverrides: normalizeRoleOverrides(input.runtimeOverrides === undefined ? prior?.runtimeOverrides : input.runtimeOverrides),
    };
    if (profiles.some(row => row.id !== next.id && row.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error('已有同名子智能体，请换一个名称');
    }
    const result = prior ? profiles.map(row => row.id === next.id ? next : row) : [...profiles, next];
    db.setSetting(LIBRARY_KEY, result);
    return result;
  });
}

function removeSubagentProfile({ id, revision }) {
  const db = getStudioDatabase();
  return db.transaction(() => {
    const profiles = listSubagentProfiles();
    existingProfile(profiles, id, revision);
    const result = profiles.filter(row => row.id !== id);
    db.setSetting(LIBRARY_KEY, result);
    return result;
  });
}

async function roleResources(cwd) {
  const { availableModels } = require('../../services/models.cjs');
  const { runtimeSelection } = require('../../runtime/tool-selection.cjs');
  const [{ models }, { tools }] = await Promise.all([availableModels(cwd), runtimeSelection()]);
  const skills = discoverSkills(cwd).skills.filter(skill => skill.available && !skill.disableModelInvocation);
  return {
    models: models.map(model => ({ id: model.id, name: `${model.providerName} · ${model.name}`,
      thinkingLevels: model.reasoning ? model.thinkingLevels : ['off'] })),
    mcpServers: getStudioDatabase().listEnabledMcpServerNames(),
    skills: skills.map(skill => ({ id: skillReferenceId(skill), name: skill.name })),
    harnesses: Object.values(getHarnessStore().profiles).map(({ id, name }) => ({ id, name })),
    defaults: resolveRoleDefaults(getSubagentConfig('user'), getSubagentConfig('project', cwd)),
    tools: [...new Set(tools.map(tool => tool.name))].filter(name => !SUBAGENT_TOOL_NAMES.has(name) && !name.startsWith('mcp__')).sort(),
  };
}

function requestedProfile(id) {
  const profile = listSubagentProfiles().find(row => row.id === id);
  if (!profile) throw new Error('引用的子智能体已不存在。请移除旧引用，再用 # 选择角色。');
  return profile;
}

function roleHarness(profile, cwd) {
  if (!profile.harnessId) return getHarnessProfile(cwd);
  const { profiles } = getHarnessStore();
  if (!Object.hasOwn(profiles, profile.harnessId)) {
    throw new Error(`「${profile.name}」的 Harness 配置已不存在，请重新选择。`);
  }
  return profiles[profile.harnessId];
}

const MENTION = /(?<![A-Za-z0-9_])(?:@"(?:\\.|[^"\\])*"|[@#]\[agent:([a-f0-9-]{36})\|[a-z0-9-]+\|([^\]\r\n|]+)\])/gu;

function readableRoleMentions(text) {
  return text.replace(MENTION, (match, id, label) => {
    if (!id) return match;
    try { return match[0] + decodeURIComponent(label); } catch { return match[0] + label; }
  });
}

// The presentation fields travel with drafts and history. Only the ID is authoritative.
function resolveProfileMentions(text, canDelegate) {
  const mentions = new Map();
  const display = text.replace(MENTION, (match, id) => {
    if (!id) return match; // A quoted file path may itself contain a mention-like filename.
    if (!canDelegate) throw new Error('请先在智能体工具中启用 subagent，再发送角色引用。');
    if (!mentions.has(id)) mentions.set(id, requestedProfile(id));
    const profile = mentions.get(id);
    const label = profile.name.replace(/[%[\]|]/gu, encodeURIComponent);
    return `${match[0]}[agent:${id}|${profile.avatarId}|${label}]`;
  });
  const readable = readableRoleMentions(display);
  const routing = mentions.size ? [
    'The user explicitly assigned work to these Studio roles. Invoke the subagent tool for each relevant assignment using its exact profileId. Give it the task and necessary context, then incorporate its result.',
    ...Array.from(mentions.values(), ({ id, name, description }) => JSON.stringify({ profileId: id, name, description })),
  ].join('\n') : '';
  return { display, readable, routing };
}

module.exports = { listSubagentProfiles, removeSubagentProfile, readableRoleMentions, requestedProfile, resolveProfileMentions, roleHarness, roleResources, saveSubagentProfile };
