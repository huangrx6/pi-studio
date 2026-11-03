module.exports = Object.freeze([
  {
id: 'studio-skills',
    tier: 'system',
    name: 'Studio 技能',
    version: '1.0.0',
    description: '发现 Studio 用户级和已信任项目级 Skill，只向系统提示词提供名称、描述与路径。',
    runtimeName: 'studio-skills',
    runtimeNames: ['studio-skills'],
    permissions: ['agent.sections'],
    requires: ['builtin:studio-harness'],
    contributes: {}
  },
]);
