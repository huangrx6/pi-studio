import { ChevronRight, GitPullRequest, Newspaper } from 'lucide-react';
import { useId, useState } from 'react';
import { SettingsDialog } from '../../shared/SettingsDialog';
import type { StudioPlan } from '../../types/plans';
import { scheduleLabel } from './plan-display';
import { planTemplates, templateDraft, type PlanTemplate } from './plan-templates';
import './styles/templates.css';

const icons = { brief: Newspaper, release: GitPullRequest };

export function PlanTemplates({ onEdit }: { onEdit: (draft: Partial<StudioPlan>) => void }) {
  const [preview, setPreview] = useState<PlanTemplate | null>(null);
  const id = useId();
  return <section className="plan-templates" aria-labelledby={id}>
    <header className="plan-list-heading">
      <h2 className="plan-section-label" id={id}>计划模板</h2>
      <button type="button" className="plan-browse" aria-haspopup="dialog" onClick={() => setPreview(planTemplates[0])}>
        浏览模板<ChevronRight aria-hidden="true" />
      </button>
    </header>
    <ul className="plan-template-list">{planTemplates.map(template => {
      const Icon = icons[template.id];
      const summaryId = id + '-' + template.id;
      return <li key={template.id}>
        <button type="button" className="plan-template" aria-haspopup="dialog"
          aria-label={'使用模板 ' + template.name + '，' + scheduleLabel(template.schedule)} aria-describedby={summaryId}
          onClick={() => onEdit(templateDraft(template))}>
          <Icon aria-hidden="true" />
          <span className="plan-template-info">
            <span className="plan-template-title"><strong>{template.name}</strong>
              <span className="plan-template-time">{scheduleLabel(template.schedule)}</span></span>
            <span className="plan-template-caption"><span id={summaryId}>{template.summary}</span>
              <span className="plan-template-use" aria-hidden="true">使用</span></span>
          </span>
        </button>
      </li>;
    })}</ul>
    {preview && <SettingsDialog title="浏览计划模板" action="使用模板" busy={false} loading={false} error={null}
      className="plan-template-dialog" footerHint="下一步可选择项目，调整指令和时间。" onClose={() => setPreview(null)}
      onSubmit={dismiss => void dismiss(() => { setPreview(null); onEdit(templateDraft(preview)); })}>
      <div className="plan-template-choices" role="radiogroup" aria-label="选择模板">
        {planTemplates.map(template => {
          const Icon = icons[template.id];
          return <label key={template.id}>
            <input className="sr-only" type="radio" name={id} checked={preview.id === template.id} onChange={() => setPreview(template)} />
            <Icon aria-hidden="true" />{template.name}
          </label>;
        })}
      </div>
      <section className="plan-template-detail" aria-label={preview.name + '预览'} aria-live="polite">
        <dl>
          <div><dt>执行时间</dt><dd>{scheduleLabel(preview.schedule)}</dd></div>
          <div><dt>读取范围</dt><dd>{preview.source}。</dd></div>
        </dl>
        <h3>生成内容</h3>
        <ul>{preview.sections.map(section => <li key={section.title}>
          <strong>{section.title}</strong><p>{section.instruction}</p>
        </li>)}</ul>
      </section>
    </SettingsDialog>}
  </section>;
}
