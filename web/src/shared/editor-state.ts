import type { editor } from 'monaco-editor/editor';
import type { CodeLocation, CodeQuery, CodeQueryResult } from '../types/workspace';

export type SourceNavigation = {
  query: (kind: CodeQuery['kind'], line?: number, column?: number) => Promise<CodeQueryResult>;
  open: (origin: CodeLocation, target: CodeLocation, side: boolean) => void;
  back: () => void;
};
export type SourceView = {
  documentId: string; viewId: string; navigation?: SourceNavigation;
  initialLine?: number; initialColumn?: number; jump?: number; scroll?: number;
  onScroll?: (top: number) => void;
};

type ViewState = { editor?: editor.ICodeEditorViewState | null; mode?: 'source' | 'preview'; editing?: boolean; lineNumbers?: boolean; jump?: number };
const views = new Map<string, ViewState>();
export function editorView(id: string) {
  let view = views.get(id);
  if (!view) {
    view = {};
    if (views.size >= 256) views.delete(views.keys().next().value!);
    views.set(id, view);
  }
  return view;
}
export function forgetEditorView(id: string) { views.delete(id); }
