import type { ReactNode } from 'react';

export function SettingsPageHeader({
  icon,
  title,
  meta,
  description,
  actions,
  className = '',
}: {
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return <header className={`settings-card settings-page-header ${className}`.trim()}>
    <span className="settings-page-header-icon" aria-hidden="true">{icon}</span>
    <div className="settings-page-header-copy">
      <div className="settings-page-header-title">
        <h2>{title}</h2>
        {meta}
      </div>
      <p>{description}</p>
    </div>
    {actions && <div className="settings-page-header-actions">{actions}</div>}
  </header>;
}
