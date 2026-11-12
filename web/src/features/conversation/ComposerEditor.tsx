import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';
import type { ClipboardEventHandler, HTMLAttributes, KeyboardEvent } from 'react';
import { ReferenceChip } from './ReferenceChip';
import { splitComposerText } from './references';
import { editorSelection, readEditorText, setEditorSelection } from './composer-editor-dom';

export type ComposerEditorHandle = {
  focus: (options?: FocusOptions) => void;
  setSelectionRange: (start: number, end: number) => void;
  replaceSelection: (text: string) => void;
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
};

type Props = Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> & {
  value: string;
  scope: string;
  commandNames: ReadonlySet<string>;
  placeholder: string;
  onChange: (value: string, cursor: number) => void;
  onPaste?: ClipboardEventHandler<HTMLDivElement>;
};
type Snapshot = { value: string; selection: [number, number] };

/** Native editable text with atomic reference chips, serialized as plain prompt text. */
export const ComposerEditor = forwardRef<ComposerEditorHandle, Props>(function ComposerEditor({
  value, scope, commandNames, placeholder, onChange, onKeyDown, onPaste,
  onCompositionStart, onCompositionEnd, onBlur, className = '', ...props
}, forwardedRef) {
  const root = useRef<HTMLDivElement>(null);
  const template = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const current = useRef(value);
  const previousScope = useRef(scope);
  const pendingSelection = useRef<[number, number] | null>(null);
  const history = useRef<{ undo: Snapshot[]; redo: Snapshot[] }>({ undo: [], redo: [] });
  const beforeInput = useRef<Snapshot | null>(null);
  const segments = useMemo(() => splitComposerText(value, commandNames), [value, commandNames]);

  function remember(snapshot: Snapshot) {
    history.current.undo.push(snapshot);
    if (history.current.undo.length > 100) history.current.undo.shift();
    history.current.redo = [];
  }

  function paint(selection?: [number, number]) {
    if (!root.current || !template.current) return;
    // Input events already mutate the editable DOM. Rebuilding the whole
    // subtree for every keystroke forces Chromium to synchronously recalculate
    // the editor and its flex siblings, which is visible as a transcript jump
    // while a response is streaming. Only replace children when tokenisation
    // or a controlled external update actually changed the rendered shape.
    const expectedTokens = segments
      .filter(segment => segment.kind === 'token')
      .map(segment => segment.text);
    const actualTokens = Array.from(root.current.querySelectorAll<HTMLElement>('[data-reference-token]'))
      .map(node => node.dataset.referenceToken || '');
    const hasExpectedTail = !value || value.endsWith('\n');
    const hasActualTail = Boolean(root.current.querySelector('[data-editor-tail="true"]'));
    const shapeMatches = readEditorText(root.current) === value
      && expectedTokens.length === actualTokens.length
      && expectedTokens.every((token, index) => token === actualTokens[index])
      && hasExpectedTail === hasActualTail;
    const scrollTop = root.current.scrollTop;
    if (!shapeMatches) {
      root.current.replaceChildren(...Array.from(template.current.childNodes, node => node.cloneNode(true)));
      root.current.scrollTop = scrollTop;
    }
    if (selection) {
      setEditorSelection(root.current, ...selection);
      if (selection[0] === selection[1]) {
        const caret = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
        const bounds = root.current.getBoundingClientRect();
        if (caret?.height) {
          if (caret.bottom > bounds.bottom - 8) root.current.scrollTop += caret.bottom - bounds.bottom + 8;
          else if (caret.top < bounds.top) root.current.scrollTop -= bounds.top - caret.top;
        }
      }
    }
  }

  useLayoutEffect(() => {
    if (previousScope.current !== scope) {
      history.current = { undo: [], redo: [] };
      previousScope.current = scope;
      pendingSelection.current = null;
      composing.current = false;
    } else if (value !== current.current) {
      remember({ value: current.current, selection: root.current ? editorSelection(root.current) : [0, 0] });
    }
    current.current = value;
    if (composing.current) return;
    const focused = document.activeElement === root.current;
    const selection = pendingSelection.current || (focused && root.current ? editorSelection(root.current) : undefined);
    paint(focused ? selection || undefined : undefined);
    pendingSelection.current = null;
  }, [value, scope, commandNames]);

  function commit(next: string, selection: [number, number], snapshot?: Snapshot) {
    if (next !== current.current) {
      if (snapshot) remember(snapshot);
      current.current = next;
      pendingSelection.current = selection;
      onChange(next, selection[1]);
    } else if (!composing.current) {
      pendingSelection.current = null;
      paint(selection);
    }
  }

  function replaceSelection(text: string) {
    const node = root.current;
    if (!node) return;
    const [start, end] = editorSelection(node);
    const raw = current.current;
    const caret = start + text.length;
    commit(raw.slice(0, start) + text + raw.slice(end), [caret, caret], { value: raw, selection: [start, end] });
  }

  function undo(redo = false) {
    if (!root.current) return;
    const source = redo ? history.current.redo : history.current.undo;
    const target = redo ? history.current.undo : history.current.redo;
    const snapshot = source.pop();
    if (!snapshot) return;
    target.push({ value: current.current, selection: editorSelection(root.current) });
    commit(snapshot.value, snapshot.selection);
  }

  useImperativeHandle(forwardedRef, () => ({
    focus: options => root.current?.focus(options),
    setSelectionRange: (start, end) => { if (root.current) setEditorSelection(root.current, start, end); },
    replaceSelection,
    get value() { return current.current; },
    get selectionStart() { return root.current ? editorSelection(root.current)[0] : 0; },
    get selectionEnd() { return root.current ? editorSelection(root.current)[1] : 0; },
  }));

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      undo(event.shiftKey || event.key.toLowerCase() === 'y');
    } else if (event.key === 'Enter') {
      event.preventDefault();
      replaceSelection('\n');
    } else if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey && !event.ctrlKey && !event.altKey && root.current) {
      const [start, end] = editorSelection(root.current);
      if (start !== end) return;
      let offset = 0;
      for (const segment of segments) {
        const next = offset + segment.text.length;
        if (segment.kind === 'token' && (event.key === 'Backspace' ? start === next : start === offset)) {
          event.preventDefault();
          setEditorSelection(root.current, offset, next);
          replaceSelection('');
          break;
        }
        offset = next;
      }
    }
  }

  return <>
    {/* React owns this inert template; the browser owns the editable DOM, including IME. */}
    <div ref={template} hidden aria-hidden="true">
      {segments.map((segment, index) => segment.kind === 'text' ? segment.text : <ReferenceChip key={index}
        reference={segment.reference || { kind: 'skill', token: segment.text, label: segment.text.slice(1) }}
        command={segment.tokenKind === 'command'} />)}
      {(!value || value.endsWith('\n')) && <br data-editor-tail="true" />}
    </div>
    <div {...props} ref={root} role="textbox" aria-multiline="true" contentEditable suppressContentEditableWarning
      aria-placeholder={placeholder}
      className={`composer-editor ${className}`} data-placeholder={placeholder} data-empty={!value}
      onKeyDown={handleKey}
      onBeforeInput={event => {
        if (!composing.current) beforeInput.current = { value: current.current, selection: editorSelection(event.currentTarget) };
        const type = (event.nativeEvent as InputEvent).inputType;
        if (type === 'historyUndo' || type === 'historyRedo') { event.preventDefault(); undo(type === 'historyRedo'); }
      }}
      onInput={event => {
        const node = event.currentTarget;
        const next = readEditorText(node);
        const selection = editorSelection(node);
        commit(next, selection, composing.current ? undefined : beforeInput.current || { value: current.current, selection });
        if (!composing.current) beforeInput.current = null;
      }}
      onCompositionStart={event => {
        composing.current = true;
        beforeInput.current = { value: current.current, selection: editorSelection(event.currentTarget) };
        onCompositionStart?.(event);
      }}
      onCompositionEnd={event => {
        composing.current = false;
        if (beforeInput.current && beforeInput.current.value !== current.current) remember(beforeInput.current);
        beforeInput.current = null;
        const node = event.currentTarget;
        commit(readEditorText(node), editorSelection(node));
        onCompositionEnd?.(event);
      }}
      onBlur={event => { composing.current = false; onBlur?.(event); }}
      onCopy={event => {
        const [start, end] = editorSelection(event.currentTarget);
        if (start === end) return;
        event.preventDefault();
        event.clipboardData.setData('text/plain', current.current.slice(start, end));
      }}
      onCut={event => {
        const [start, end] = editorSelection(event.currentTarget);
        if (start === end) return;
        event.preventDefault();
        event.clipboardData.setData('text/plain', current.current.slice(start, end));
        replaceSelection('');
      }}
      onPaste={event => {
        onPaste?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        replaceSelection(event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'));
      }}
      onDrop={event => {
        // Files bubble to the attachment drop handler. Never import arbitrary HTML.
        if (!event.dataTransfer.files.length) { event.preventDefault(); replaceSelection(event.dataTransfer.getData('text/plain')); }
      }}
      onDragStart={event => event.preventDefault()}
    />
  </>;
});
