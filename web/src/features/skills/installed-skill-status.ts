export function installedSkillStatus(skill: { scope: 'user' | 'project'; available: boolean; trusted: boolean; trustChanged: boolean; disableModelInvocation: boolean }) {
  const canTrust = skill.scope === 'project' && !skill.available;
  if (!skill.available) {
    return {
      label: skill.trustChanged ? '内容已变化，需重新信任' : skill.scope === 'project' && !skill.trusted ? '等待信任' : '不可用',
      canTrust,
      trustLabel: skill.trustChanged ? '重新信任' : '信任技能',
    };
  }
  return { label: skill.disableModelInvocation ? '仅显式调用' : '自动发现', canTrust: false, trustLabel: '信任技能' };
}
