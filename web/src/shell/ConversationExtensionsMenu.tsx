import { useEffect, useId, useRef } from 'react';
import { Plug } from 'lucide-react';
import { ExtensionPanelPicker, type ExtensionPanelPickerProps } from '../features/extensions/ExtensionPanelPicker';

export function ConversationExtensionsMenu({
  open, onOpenChange, ...picker
}: ExtensionPanelPickerProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('.extension-panel-picker input, .extension-panel-picker button')?.focus();
    const onOutside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      onOpenChange(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('focusin', onOutside);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('focusin', onOutside);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);
  return <div className="workspace-menu-anchor" ref={root}>
    <button ref={trigger} type="button" className={`icon-button${open ? ' is-active' : ''}`}
      aria-label="扩展" title="扩展" aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => onOpenChange(!open)}>
      <Plug aria-hidden="true" />
    </button>
    {open && <section className="workspace-menu" id={id} role="dialog" aria-label="扩展">
      <ExtensionPanelPicker {...picker} onOpenPanel={id => { onOpenChange(false); picker.onOpenPanel(id); }}
        onManage={() => { onOpenChange(false); picker.onManage(); }} />
    </section>}
  </div>;
}
