import type { PlanInput, PlanSchedule } from '../../types/plans';
import { localZone, workingDays } from './plan-display';

export type PlanTemplate = {
  id: 'brief' | 'release';
  name: string;
  summary: string;
  schedule: PlanSchedule;
  source: string;
  sections: { title: string; instruction: string }[];
  ifEmpty: string;
};

export const planTemplates: PlanTemplate[] = [
  {
    id: 'brief', name: '工作日项目简报',
    summary: '汇总上个工作日以来的进展和待办。',
    schedule: { kind: 'weekly', days: workingDays, time: '09:00', zone: localZone() },
    source: '当前分支从上个工作日至今的提交、文件变更和项目待办更新',
    sections: [
      { title: '项目进展', instruction: '按事项归纳有意义的变化，每项附一条提交号或文件路径。' },
      { title: '今天跟进', instruction: '列出记录中尚未解决的事项，写清接下来要确认什么。' },
    ],
    ifEmpty: '如果没有新进展或待办，简短说明即可。',
  },
  {
    id: 'release', name: '每周发布摘要',
    summary: '把本周的功能与修复整理成发布说明草稿。',
    schedule: { kind: 'weekly', days: [5], time: '17:00', zone: localZone() },
    source: '当前分支最近七天的提交、代码变更和项目中已有的发布记录',
    sections: [
      { title: '新增与修复', instruction: '按新增功能和修复分组，说明对用户的影响，每项附上提交号。' },
      { title: '发布前确认', instruction: '列出需要核对的兼容性变化和升级步骤，注明依据。' },
    ],
    ifEmpty: '如果本周没有可发布的变更，只写一句说明。',
  },
];

export function templateDraft(template: PlanTemplate): Pick<PlanInput, 'name' | 'prompt' | 'schedule'> {
  const prompt = [
    `阅读${template.source}，在本次运行结果中写一份${template.name}。`,
    ...template.sections.map(section => section.title + '\n' + section.instruction),
    template.ifEmpty,
  ].join('\n\n');
  return { name: template.name, prompt, schedule: { ...template.schedule, zone: localZone() } };
}
