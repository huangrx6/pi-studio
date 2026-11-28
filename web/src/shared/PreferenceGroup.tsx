import { useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import './styles/preference-group.css';

export function PreferenceGroup({ title, summary, description, actions, grouped = false, defaultOpen = false, lazy = false, onCollapse, children }: {
  title: string;
  summary?: string;
  description?: string;
  actions?: ReactNode;
  grouped?: boolean;
  defaultOpen?: boolean;
  lazy?: boolean;
  onCollapse?: () => void;
  children?: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const body = children && (!lazy || open || summary === undefined) && <div className="preference-group-body">{children}</div>;
  return <section className={grouped ? 'preference-group-row' : 'settings-preference-card'} aria-labelledby={id}>
    {summary !== undefined ? <details className="preference-disclosure" open={open} onToggle={event => {
      const expanded = event.currentTarget.open;
      setOpen(expanded);
      if (!expanded) onCollapse?.();
    }}>
      <summary aria-labelledby={id} aria-describedby={`${id}-value`}>
        <h2 className="preference-disclosure-heading" aria-labelledby={id}>
          <span id={id}>{title}</span>
          <span className="preference-current-value" id={`${id}-value`}>{summary}</span>
          <ChevronRight aria-hidden="true" />
        </h2>
      </summary>
      {body}
    </details> : <>
      <header className="preference-group-head">
        <div><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</div>
        {actions && <div className="preference-group-actions">{actions}</div>}
      </header>
      {body}
    </>}
  </section>;
}

export function PreferenceRow({ title, description, control, className = '', copyClassName = '', controlClassName = '', descriptionClassName }: {
  title: string;
  description?: ReactNode;
  control: ReactNode;
  className?: string;
  copyClassName?: string;
  controlClassName?: string;
  descriptionClassName?: string;
}) {
  return <div className={`preference-row ${className}`.trim()}>
    <div className={`preference-row-copy ${copyClassName}`.trim()}>
      <h3>{title}</h3>
      {description && <p className={descriptionClassName}>{description}</p>}
    </div>
    <div className={`preference-row-control ${controlClassName}`.trim()}>{control}</div>
  </div>;
}
