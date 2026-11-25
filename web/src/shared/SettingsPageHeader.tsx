import type { ReactNode } from 'react';
import './styles/settings-page-header.css';

/** A page title on the settings surface, separate from its editable cards. */
export function SettingsPageHeader({
  icon,
  iconPosition = 'start',
  title,
  meta,
  actions,
  className = '',
}: {
  icon?: ReactNode;
  iconPosition?: 'start' | 'end';
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return <header className={`settings-page-header${iconPosition === 'end' ? ' has-trailing-icon' : ''} ${className}`.trim()}>
    <div className="settings-page-header-copy">
      {icon && <span className="settings-page-header-icon" aria-hidden="true">{icon}</span>}
      <div className="settings-page-header-title">
        <h1>{title}</h1>
        {meta && <div className="settings-page-header-meta">{meta}</div>}
      </div>
    </div>
    {actions && <div className="settings-page-header-actions">{actions}</div>}
  </header>;
}
