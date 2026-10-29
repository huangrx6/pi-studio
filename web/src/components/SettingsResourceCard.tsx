import type { ReactNode } from 'react';

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

export function SettingsResourceCard({
  children,
  className,
  disabled = false,
  selected = false,
  expanded = false,
}: {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  selected?: boolean;
  expanded?: boolean;
}) {
  return <article
    className={classes(
      'settings-resource-card',
      className,
      disabled && 'is-disabled',
      selected && 'is-selected',
      expanded && 'is-expanded',
    )}
  >
    {children}
  </article>;
}

export function SettingsResourceCardMain({
  children,
  className,
  onClick,
  ariaLabel,
  disabled = false,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const mainClassName = classes('settings-resource-card-main', className);
  return onClick
    ? <button
      type="button"
      className={mainClassName}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
    >{children}</button>
    : <div className={mainClassName}>{children}</div>;
}

export function SettingsResourceCardIcon({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span className={classes('settings-resource-card-icon', className)} aria-hidden="true">
    {children}
  </span>;
}

export function SettingsResourceCardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={classes('settings-resource-card-body', className)}>{children}</div>;
}

export function SettingsResourceCardFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <footer className={classes('settings-resource-card-footer', className)}>{children}</footer>;
}
