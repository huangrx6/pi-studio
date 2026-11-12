import type { ReactNode } from 'react';
import './settings-page-header.css';

/** A page title on the settings surface, separate from its editable cards. */
export function SettingsPageHeader({
  icon,
  title,
  meta,
  actions,
  className = '',
}: {
  /** Accepted by existing callers; page identity is carried by the title and navigation. */
  icon?: ReactNode;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return <header className={`settings-page-header ${className}`.trim()}>
    <div className="settings-page-header-copy">
      <div className="settings-page-header-title">
        {icon && <span className="settings-page-header-icon" aria-hidden="true">{icon}</span>}
        <h1>{title}</h1>
        {meta && <span className="settings-page-header-meta">{meta}</span>}
      </div>
    </div>
    {actions && <div className="settings-page-header-actions">{actions}</div>}
  </header>;
}
