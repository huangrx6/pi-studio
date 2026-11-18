// Load the real shared JSX component for the existing server-rendered feature tests.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const context = { exports: {}, require: id => id.endsWith('.css') ? {} : require(id) };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../../../web/src/shared/Accordion.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, context);
export const { Accordion } = context.exports;
