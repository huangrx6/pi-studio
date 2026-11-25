import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Accordion } from '../../shared/Accordion';
import type { HarnessProfile, HarnessSectionDefinition, HarnessSectionId } from '../../types/harness-types';

export function HarnessPromptSections({ definitions, draft, onToggle, onOverride }: {
  definitions: HarnessSectionDefinition[]; draft: HarnessProfile;
  onToggle: (id: HarnessSectionId, enabled: boolean) => void;
  onOverride: (id: HarnessSectionId, value: string) => void;
}) {
  const [editing, setEditing] = useState<HarnessSectionId | null>(null);
  const enabledCount = definitions.filter(section => draft.sections[section.id] !== false).length;
  return <Accordion className="harness-disclosure harness-composition" summary="提示词组成" defaultOpen
    badge={`${enabledCount} / ${definitions.length} 段启用`}>
    <div className="harness-section-list">
      {definitions.map(({ id, label, description }) => {
        const enabled = draft.sections[id] !== false;
        const value = draft.sectionOverrides[id] || '';
        const expanded = editing === id;
        const editorId = `harness-override-${id}`;
        return <div className="harness-section-item" key={id}>
          <div className="harness-section-row">
            <button type="button" className="harness-section-toggle settings-row-link" aria-expanded={expanded}
              aria-controls={editorId} onClick={() => setEditing(expanded ? null : id)}>
              <span className="harness-section-label">{label}<ChevronRight className="settings-row-link-indicator" aria-hidden="true" /></span>
              {value.trim() && <small>已覆盖</small>}
            </button>
            <button type="button" className={`switch ${enabled ? 'is-on' : ''}`} role="switch"
              aria-label={label} aria-checked={enabled} onClick={() => onToggle(id, !enabled)}><span /></button>
          </div>
          <div id={editorId} className="harness-override-editor" hidden={!expanded}>
            <p>{description}</p>
            <textarea aria-label={`${label}覆盖内容`} placeholder="留空使用默认内容" rows={3} maxLength={32_768}
              disabled={!enabled} value={value} onChange={event => onOverride(id, event.target.value)} />
            <div className="harness-inline-actions">
              <span className="harness-count">{value.length.toLocaleString()} / 32,768</span>
              <button type="button" className="settings-text-button" disabled={!value}
                onClick={() => onOverride(id, '')}>恢复此段默认</button>
            </div>
          </div>
        </div>;
      })}
    </div>
  </Accordion>;
}
