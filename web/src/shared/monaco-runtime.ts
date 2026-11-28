import * as monaco from 'monaco-editor/editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker&inline';
import 'monaco-editor/features/codeEditor/register';
import 'monaco-editor/features/diffEditor/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/comment/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens';
import 'monaco-editor/features/tokenization/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/features/lineSelection/register';
import 'monaco-editor/features/gotoLine/register';
import 'monaco-editor/features/quickCommand/register';
import 'monaco-editor/features/hover/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/less/register';
import 'monaco-editor/languages/definitions/scss/register';
import 'monaco-editor/languages/definitions/xml/register';
import 'monaco-editor/languages/definitions/yaml/register';
import 'monaco-editor/languages/definitions/ini/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/ruby/register';
import 'monaco-editor/languages/definitions/go/register';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/languages/definitions/kotlin/register';
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/csharp/register';
import 'monaco-editor/languages/definitions/swift/register';
import 'monaco-editor/languages/definitions/dart/register';
import 'monaco-editor/languages/definitions/php/register';
import 'monaco-editor/languages/definitions/lua/register';
import 'monaco-editor/languages/definitions/r/register';
import 'monaco-editor/languages/definitions/scala/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/powershell/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/graphql/register';
import 'monaco-editor/languages/definitions/dockerfile/register';
import { previewLanguageForFile } from './file-preview';
import type { SourceNavigation } from './editor-state';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
// The full JSON language service loads optional editor contributions after the
// standalone services have started. Both JSON views only need its tokenizer.
monaco.languages.register({ id: 'json', extensions: ['.json', '.jsonc', '.jsonl', '.ndjson', '.bowerrc', '.jshintrc', '.jscsrc', '.eslintrc', '.babelrc', '.har'],
  aliases: ['JSON', 'json'], mimetypes: ['application/json'] });
monaco.languages.registerTokensProviderFactory('json', { async create() {
  const { createTokenizationSupport } = await import('monaco-editor/languages/features/json/tokenization');
  return createTokenizationSupport(true);
} });
monaco.languages.setLanguageConfiguration('json', {
  wordPattern: /(-?\d*\.\d\w*)|([^\[\]{}:",\s]+)/g,
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [{ open: '{', close: '}', notIn: ['string'] }, { open: '[', close: ']', notIn: ['string'] }, { open: '"', close: '"', notIn: ['string'] }],
});
export { monaco };
export function languageFor(path: string) {
  if (/\.(jsonc?|jsonl|ndjson)$/i.test(path)) return 'json';
  const language = previewLanguageForFile(path);
  if (language === 'bash') return 'shell';
  if (language === 'c') return 'cpp';
  return language === 'text' ? 'plaintext' : language;
}

function applyTheme() {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const color = (token: string) => styles.getPropertyValue('--' + token).trim();
  const dark = root.dataset.theme === 'dark';
  const name = dark ? 'studio-dark' : 'studio-light';
  const rules = Object.entries({ keyword: 'keyword', 'keyword.flow': 'flow', string: 'string', 'string.key': 'variable',
    number: 'number', comment: 'comment', type: 'type', class: 'type', enum: 'type', interface: 'type', namespace: 'type',
    typeParameter: 'type', function: 'function', method: 'function', parameter: 'variable', variable: 'variable',
    property: 'variable', enumMember: 'variable' }).map(([token, role]) => ({ token, foreground: color('editor-' + role).slice(1) }));
  monaco.editor.defineTheme(name, { base: dark ? 'vs-dark' : 'vs', inherit: true, rules, colors: {
    'editor.background': color('surface-canvas'), 'editor.foreground': color('text'),
    'editorGutter.background': color('surface-canvas'), 'editorLineNumber.foreground': color('muted'),
    'editorLineNumber.activeForeground': color('text'), 'editor.lineHighlightBorder': color('surface-chrome'),
    'scrollbarSlider.background': color('scrollbar'), 'scrollbarSlider.hoverBackground': color('scrollbar-hover'),
    'scrollbarSlider.activeBackground': color('muted'),
    'editorWidget.background': color('surface-chrome'), 'editorHoverWidget.background': color('surface-chrome'),
    'menu.background': color('surface-chrome'), 'input.background': color('surface-canvas'), 'focusBorder': color('accent'),
  } });
  monaco.editor.setTheme(name);
}
applyTheme();
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });

export function sourceOptions(): monaco.editor.IStandaloneEditorConstructionOptions {
  const css = getComputedStyle(document.documentElement);
  return { automaticLayout: true, fontFamily: css.getPropertyValue('--mono'), fontSize: parseFloat(css.getPropertyValue('--text-body')),
    minimap: { enabled: false }, scrollBeyondLastLine: false, fixedOverflowWidgets: true, tabSize: 2,
    scrollbar: { vertical: 'hidden', verticalScrollbarSize: 0, horizontal: 'auto', horizontalScrollbarSize: 10, horizontalSliderSize: 4, useShadows: false },
    overviewRulerLanes: 0, overviewRulerBorder: false, hideCursorInOverviewRuler: true,
    padding: { top: 10, bottom: 10 }, lineNumbersMinChars: 3, glyphMargin: false,
    editContext: false, stickyScroll: { enabled: false }, tabFocusMode: false, 'semanticHighlighting.enabled': true };
}

const navigationFor = new WeakMap<monaco.editor.ITextModel, () => SourceNavigation | undefined>();
const tokens = ['class', 'enum', 'interface', 'namespace', 'typeParameter', 'type', 'parameter', 'variable', 'enumMember', 'property', 'function', 'method'];
for (const language of ['javascript', 'typescript']) monaco.languages.registerDocumentSemanticTokensProvider(language, {
  getLegend: () => ({ tokenTypes: tokens, tokenModifiers: [] }),
  async provideDocumentSemanticTokens(model, _last, cancel) {
    const navigation = navigationFor.get(model)?.();
    if (!navigation || cancel.isCancellationRequested) return null;
    const version = model.getVersionId();
    try {
      const result = await navigation.query('tokens');
      if (cancel.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return null;
      return { data: Uint32Array.from(result.tokens ?? []) };
    } catch { return null; } // Lexical tokens remain available while a workspace file is moving or closing.
  },
  releaseDocumentSemanticTokens() {},
});

type Entry = { model: monaco.editor.ITextModel; users: number; providers: Set<() => SourceNavigation | undefined> };
const models = new Map<string, Entry>();
export function acquireModel(key: string | undefined, path: string, text: string, navigate?: () => SourceNavigation | undefined) {
  const id = key ?? crypto.randomUUID();
  let entry = models.get(id);
  if (!entry) {
    const uri = monaco.Uri.from({ scheme: 'studio-source', path: '/' + id + '/' + path.split(/[\\/]/).pop() });
    entry = { model: monaco.editor.createModel(text, languageFor(path), uri), users: 0, providers: new Set() };
  }
  models.delete(id);
  models.set(id, entry);
  entry.users++;
  if (navigate) {
    entry.providers.add(navigate);
    navigationFor.set(entry.model, navigate);
  }
  const current = entry;
  return { model: current.model, release() {
    current.users--;
    if (navigate) {
      current.providers.delete(navigate);
      const remaining = current.providers.values().next().value;
      if (remaining) navigationFor.set(current.model, remaining);
      else navigationFor.delete(current.model);
    }
    // Live splits share one undo buffer. Recently hidden tabs keep it within a bounded cache.
    let bytes = 0, idle = 0;
    for (const [name, item] of [...models].reverse()) {
      if (item.users) continue;
      bytes += item.model.getValueLength() * 2;
      if ((name === id && !key) || ++idle > 12 || bytes > 16 * 1024 * 1024) { models.delete(name); item.model.dispose(); }
    }
  } };
}
