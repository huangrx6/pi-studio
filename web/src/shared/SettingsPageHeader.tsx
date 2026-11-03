import type { ReactNode } from 'react';

export function SettingsPageHeader({
  icon,
  title,
  meta,
  actions,
  className = '',
}: {
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return <header className={`settings-card settings-page-header ${className}`.trim()}>
    <span className="settings-page-header-icon" aria-hidden="true">{icon}</span>
    <div className="settings-page-header-copy">
      <div className="settings-page-header-title">
        <h1>{title}</h1>
        {meta}
      </div>
    </div>
    {actions && <div className="settings-page-header-actions">{actions}</div>}
  </header>;
}
