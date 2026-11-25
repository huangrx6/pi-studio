import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import './styles/settings-toast.css';

type ToastTone = 'success' | 'error' | 'info';
type Toast = { message: string; tone: ToastTone };
type ScopedToast = Toast & { dialog: HTMLDialogElement | null };
type ActionToast = ScopedToast & { children: ReactNode };
type ShowToast = (message: string, tone?: ToastTone) => void;
type SetActionToast = (id: string, toast?: ActionToast) => void;
const SettingsToastContext = createContext<ShowToast>(() => {});
const ActionToastContext = createContext<SetActionToast>(() => {});
const activeModalSelector = 'dialog:modal:not([data-modal-closing])';

function activeModal() {
  return document.activeElement?.closest<HTMLDialogElement>(activeModalSelector)
    ?? Array.from(document.querySelectorAll<HTMLDialogElement>(activeModalSelector)).at(-1)
    ?? null;
}

export function useSettingsToast() {
  return useContext(SettingsToastContext);
}

export function SettingsToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ScopedToast>();
  const [actions, setActions] = useState(() => new Map<string, ActionToast>());
  const showToast = useCallback<ShowToast>((message, tone = 'success') => {
    if (message.trim()) setToast({ message, tone, dialog: tone === 'error' ? activeModal() : null });
  }, []);
  const setAction = useCallback<SetActionToast>((id, entry) => {
    setActions(previous => {
      const next = new Map(previous);
      if (entry) next.set(id, entry);
      else next.delete(id);
      return next;
    });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), toast.tone === 'error' ? 6000 : 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  return <SettingsToastContext.Provider value={showToast}>
    <ActionToastContext.Provider value={setAction}>
      {children}
      {(toast || actions.size > 0) && <ToastViewport toast={toast} actions={actions} />}
    </ActionToastContext.Provider>
  </SettingsToastContext.Provider>;
}

export function SettingsToast({ message, tone, children }: Toast & { children?: ReactNode }) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const setAction = useContext(ActionToastContext);
  useLayoutEffect(() => {
    setAction(id, { message, tone, children, dialog: anchor.current?.closest('dialog') ?? null });
  }, [setAction, id, message, tone, children]);
  useLayoutEffect(() => () => setAction(id), [setAction, id]);
  return <span hidden ref={anchor} />;
}

function ToastViewport({ toast, actions }: { toast?: ScopedToast; actions: Map<string, ActionToast> }) {
  const [host, setHost] = useState<HTMLElement>();
  const layerRef = useRef<HTMLDivElement>(null);
  const modal = host?.matches(activeModalSelector) ? host : null;
  const visibleActions = Array.from(actions).filter(([, entry]) => entry.dialog === modal);
  const visibleToast = toast?.tone === 'error' && toast.dialog !== modal ? undefined : toast;
  const showLayer = Boolean(visibleToast || visibleActions.length);
  useLayoutEffect(() => {
    const updateHost = () => {
      const next = activeModal()
        ?? document.querySelector<HTMLElement>('.settings-toast-stack')
        ?? document.body;
      setHost(previous => previous === next ? previous : next);
    };
    updateHost();
    const observer = new MutationObserver(updateHost);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'data-modal-closing'] });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!modal || !layer?.isConnected) return;
    // A native modal is above the settings shell. Its manual popover stays
    // in the top layer and keeps the live region inside the active dialog.
    layer.setAttribute('popover', 'manual');
    layer.showPopover();
    return () => { if (layer.matches(':popover-open')) layer.hidePopover(); };
  }, [host, modal, showLayer]);

  if (!host || !showLayer) return null;
  const content = <>
    {visibleActions.map(([id, entry]) => <ToastMessage key={id} {...entry} />)}
    {visibleToast && <ToastMessage {...visibleToast} />}
  </>;
  return createPortal(modal || host === document.body
    ? <div ref={layerRef} className="settings-toast-layer">{content}</div>
    : content, host);
}

function ToastMessage({ message, tone, children }: Toast & { children?: ReactNode }) {
  const Icon = tone === 'success' ? CircleCheck : tone === 'error' ? CircleAlert : Info;
  return <div className={`settings-toast is-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    <span className="settings-toast-icon" aria-hidden="true"><Icon /></span>
    <span className="settings-toast-message">{message}</span>
    {children && <div className="settings-toast-action">{children}</div>}
  </div>;
}
