declare module 'monaco-editor/languages/features/json/tokenization' {
  import type { languages } from 'monaco-editor/editor';
  export function createTokenizationSupport(supportComments: boolean): languages.TokensProvider;
}
