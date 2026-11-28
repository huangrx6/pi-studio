import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { acquireModel, monaco, sourceOptions } from './monaco-runtime';
import { editorView, type SourceView } from './editor-state';
import { errorText } from './error-text';
import { desktopPlatform } from './desktop-platform';
import type { CodeLocation } from '../types/workspace';

type Props = { path: string; label: string; text: string; editing: boolean; lineNumbers: boolean;
  view?: SourceView; onChange: (text: string) => void; onSave: () => void };
type Results = { title: string; origin?: CodeLocation; locations?: CodeLocation[]; side?: boolean };
export function SourceEditor(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor>();
  const requestId = useRef(0);
  const [results, setResults] = useState<Results>();
  const { path, editing, text, lineNumbers, view } = props;
  const appliedJump = useRef<number>();
  function closeResults() {
    requestId.current++;
    setResults(undefined);
    editor.current?.focus();
  }
  useLayoutEffect(() => {
    const initial = latest.current;
    const state = initial.view && editorView(initial.view.viewId);
    const resource = acquireModel(initial.view?.documentId, path, initial.text, () => latest.current.view?.navigation);
    if (resource.model.getValue(undefined, true) !== initial.text) resource.model.setValue(initial.text);
    const instance = monaco.editor.create(host.current!, { ...sourceOptions(), model: resource.model,
      ariaLabel: initial.label, readOnly: !initial.editing, lineNumbers: initial.lineNumbers ? 'on' : 'off' });
    editor.current = instance;
    if (state?.editor) instance.restoreViewState(state.editor);
    else if (initial.view?.scroll) instance.setScrollTop(initial.view.scroll);
    appliedJump.current = state?.jump;
    async function locate(kind: 'definition' | 'references', side = false, position = instance.getPosition()) {
      const navigation = latest.current.view?.navigation;
      if (!navigation || !position) return;
      const origin = { path, line: position.lineNumber, column: position.column };
      const request = ++requestId.current;
      const version = resource.model.getVersionId();
      setResults(undefined);
      const loading = setTimeout(() => {
        if (request === requestId.current) setResults({ title: kind === 'references' ? '正在查找引用…' : '正在查找定义…' });
      }, 200);
      try {
        const { locations = [] } = await navigation.query(kind, origin.line, origin.column);
        if (request !== requestId.current) return;
        if (resource.model.getVersionId() !== version) { setResults(undefined); return; }
        if (kind === 'definition' && locations.length === 1) {
          setResults(undefined);
          navigation.open(origin, locations[0], side);
        } else setResults({ origin, locations, side,
          title: kind === 'references' ? (locations.length ? `引用位置（${locations.length}）` : '未找到引用') : locations.length ? '选择定义' : '未找到定义' });
      } catch (error) {
        if (request === requestId.current) setResults({ title: errorText(error) });
      } finally {
        clearTimeout(loading);
      }
    }
    if (initial.view?.navigation) {
      const mac = desktopPlatform() === 'darwin';
      const actions = [
        { id: 'definition', label: '转到定义', keys: [monaco.KeyCode.F12], run: () => locate('definition') },
        { id: 'definitionAside', label: '在右侧打开定义', keys: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F12], run: () => locate('definition', true) },
        { id: 'references', label: '查找所有引用', keys: [monaco.KeyMod.Shift | monaco.KeyCode.F12], run: () => locate('references') },
        { id: 'back', label: '返回上一位置', keys: [mac ? monaco.KeyMod.WinCtrl | monaco.KeyCode.Minus : monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow], run: () => latest.current.view?.navigation?.back() },
      ];
      actions.forEach((a, index) => instance.addAction({ id: 'studio.' + a.id, label: a.label, keybindings: a.keys,
        contextMenuGroupId: 'navigation', contextMenuOrder: index, run: a.run }));
      const link = instance.createDecorationsCollection();
      instance.onMouseMove(({ event, target }) => {
        const word = target.position && (mac ? event.metaKey : event.ctrlKey) && resource.model.getWordAtPosition(target.position);
        if (word && target.position) link.set([{ range: new monaco.Range(target.position.lineNumber, word.startColumn, target.position.lineNumber, word.endColumn),
          options: { inlineClassName: 'studio-definition-link' } }]);
        else link.clear();
      });
      instance.onMouseLeave(() => link.clear());
      instance.onKeyUp(() => link.clear());
      instance.onMouseDown(({ event, target }) => {
        if (event.leftButton && (mac ? event.metaKey : event.ctrlKey) && target.type === monaco.editor.MouseTargetType.CONTENT_TEXT && target.position) {
          event.preventDefault(); void locate('definition', event.altKey, target.position);
        }
      });
    }
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => latest.current.onSave());
    instance.onDidChangeModelContent(event => {
      // setValue synchronizes external changes and discards in every view of the model.
      if (!event.isFlush && latest.current.editing) latest.current.onChange(resource.model.getValue(undefined, true));
    });
    let scrollTimer: ReturnType<typeof setTimeout>;
    let scrollTop: number | undefined;
    const flush = () => { if (scrollTop !== undefined) latest.current.view?.onScroll?.(scrollTop); };
    instance.onDidScrollChange(e => {
      if (!e.scrollTopChanged) return;
      scrollTop = e.scrollTop;
      clearTimeout(scrollTimer); scrollTimer = setTimeout(flush, 220);
    });
    return () => {
      requestId.current++; clearTimeout(scrollTimer); flush();
      if (state) state.editor = instance.saveViewState();
      instance.dispose(); resource.release(); editor.current = undefined;
    };
  }, [path, view?.viewId, view?.documentId]);
  useLayoutEffect(() => {
    const instance = editor.current, model = instance?.getModel();
    if (!model || !instance) return;
    if (model.getValue(undefined, true) !== text) model.setValue(text);
    instance.updateOptions({ readOnly: !editing, lineNumbers: lineNumbers ? 'on' : 'off' });
  }, [text, editing, lineNumbers, path]);
  useEffect(() => { if (editing) editor.current?.focus(); }, [editing]);
  useEffect(() => {
    if (!view?.initialLine || !editor.current) return;
    const state = editorView(view.viewId);
    const jump = view.jump ?? 0;
    if (appliedJump.current === jump) return;
    const position = { lineNumber: view.initialLine, column: view.initialColumn ?? 1 };
    editor.current.setPosition(position);
    editor.current.revealPositionInCenter(position, monaco.editor.ScrollType.Immediate);
    if (jump) editor.current.focus();
    state.jump = appliedJump.current = jump;
  }, [view?.viewId, view?.initialLine, view?.initialColumn, view?.jump]);
  return <div className="studio-source-editor" onKeyDownCapture={event => {
    if (results && event.key === 'Escape') {
      event.stopPropagation();
      closeResults();
    }
  }}>
    <div className="studio-monaco-host" ref={host} />
    {results && <section className="source-locations" aria-label={results.title}>
      <header><strong role="status">{results.title}</strong><button className="icon-button" aria-label="关闭导航结果" onClick={closeResults}><X /></button></header>
      {results.locations?.map(location => <button type="button" key={`${location.path}:${location.line}:${location.column}`} onClick={() => {
        props.view?.navigation?.open(results.origin!, location, Boolean(results.side)); setResults(undefined);
      }}>{location.path} <span>{location.line}:{location.column}</span></button>)}
    </section>}
  </div>;
}
