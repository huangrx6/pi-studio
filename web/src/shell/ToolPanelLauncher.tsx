import { PanelsTopLeft } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HintButton } from '../shared/HintButton';
import { useSettingsToast } from '../shared/SettingsToast';
import { errorText } from '../shared/error-text';

/** The native tool panel shares one set of bounds across the editors and workspace side panel. */
export function ToolPanelAnchor() {
  const anchor = useRef<HTMLSpanElement>(null);
  const toast = useSettingsToast();
  useLayoutEffect(() => {
    const element = anchor.current;
    if (!element || !window.piApi?.setToolWindowAnchor) return;
    const measure = () => {
      const { x, y, width, height } = element.getBoundingClientRect();
      if (width && height) void window.piApi.setToolWindowAnchor({ x, y, width, height })
        .catch(error => toast(errorText(error), 'error'));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [toast]);
  useEffect(() => {
    const dismissForDialog = (event: Event) => {
      if (event.target instanceof HTMLDialogElement && (event as ToggleEvent).newState === 'open') {
        void window.piApi.hideToolWindow().catch(error => toast(errorText(error), 'error'));
      }
    };
    document.addEventListener('beforetoggle', dismissForDialog, true);
    return () => document.removeEventListener('beforetoggle', dismissForDialog, true);
  }, [toast]);
  return <span ref={anchor} className="tool-panel-anchor" aria-hidden="true" />;
}

export function ToolPanelLauncher() {
  const [visible, setVisible] = useState<boolean>();
  const toast = useSettingsToast();
  useEffect(() => {
    let received = false;
    const off = window.piApi.onToolWindowVisibility(value => { received = true; setVisible(value); });
    void window.piApi.toolWindowVisible().then(value => { if (!received) setVisible(Boolean(value)); })
      .catch(error => {
        if (received) return;
        setVisible(false);
        toast(errorText(error), 'error');
      });
    return () => { received = true; off(); };
  }, [toast]);
  const label = visible ? '收起工具面板' : '打开工具面板';
  // The native tools view can cover the area above the status bar while open.
  return <HintButton className="tools-window-entry icon-button" placement={visible ? 'left' : 'above-end'}
    aria-label={label} aria-expanded={visible} aria-busy={visible === undefined}
    onPointerDown={event => { if (event.pointerType === 'mouse') event.preventDefault(); }}
    onClick={() => void window.piApi.toggleToolWindow().catch(error => toast(errorText(error), 'error'))}>
    <PanelsTopLeft aria-hidden="true"/>
  </HintButton>;
}
