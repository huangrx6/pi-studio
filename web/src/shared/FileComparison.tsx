import { useLayoutEffect, useRef } from 'react';
import { acquireModel, monaco, sourceOptions } from './monaco-runtime';
import './styles/file-preview.css';

export function FileComparison({ original, modified, originalPath, modifiedPath }: {
  original: string; modified: string; originalPath: string; modifiedPath: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const models = useRef<monaco.editor.IDiffEditorModel>();
  useLayoutEffect(() => {
    const before = acquireModel(undefined, originalPath, original);
    const after = acquireModel(undefined, modifiedPath, modified);
    const editor = monaco.editor.createDiffEditor(host.current!, { ...sourceOptions(), readOnly: true, originalEditable: false,
      renderSideBySide: true, renderOverviewRuler: false, useInlineViewWhenSpaceIsLimited: false, ignoreTrimWhitespace: false, ariaLabel: '逐行比较文件' });
    models.current = { original: before.model, modified: after.model };
    editor.setModel(models.current);
    return () => { editor.dispose(); before.release(); after.release(); models.current = undefined; };
  }, [originalPath, modifiedPath]);
  useLayoutEffect(() => {
    const pair = models.current;
    if (pair?.original.getValue(undefined, true) !== original) pair?.original.setValue(original);
    if (pair?.modified.getValue(undefined, true) !== modified) pair?.modified.setValue(modified);
  }, [original, modified]);
  return <div className="studio-source-editor" aria-label="逐行比较文件"><div className="studio-monaco-host" ref={host} /></div>;
}
