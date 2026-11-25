import { useId, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import './styles/settings-profile-library.css';

export function SettingsProfileLibrary({ title, count, actions, children }: {
  title: string; count: number; actions: ReactNode; children: ReactNode;
}) {
  const titleId = useId();
  return <section className="settings-profile-library" aria-labelledby={titleId}>
    <header className="settings-profile-toolbar">
      <h2 id={titleId}>{title}{count > 0 && <span>{count}</span>}</h2>
      <div className="settings-profile-actions">{actions}</div>
    </header>
    {children}
  </section>;
}

export function SettingsProfileCard({ name, icon, subtitle, description, summary, onEdit }: {
  name: string; icon: ReactNode; subtitle: string; description?: ReactNode; summary: string; onEdit: () => void;
}) {
  const id = useId();
  return <button type="button" className="settings-preference-card settings-profile-card"
    aria-label={'编辑' + name} aria-describedby={[`${id}-subtitle`, description && `${id}-description`, `${id}-summary`].filter(Boolean).join(' ')}
    aria-haspopup="dialog" onClick={onEdit}>
    <span className="settings-profile-head">{icon}<span><strong>{name}</strong><small id={`${id}-subtitle`}>{subtitle}</small></span></span>
    {description && <span className="settings-profile-description" id={`${id}-description`}>{description}</span>}
    <span className="settings-profile-foot"><span id={`${id}-summary`}>{summary}</span><span>编辑 <ChevronRight aria-hidden="true" /></span></span>
  </button>;
}
