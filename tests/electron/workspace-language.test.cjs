const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { queryWorkspaceLanguage } = require('../../electron/main/services/workspace-language.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-language-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return fs.realpathSync(directory);
}

test('definitions, references and semantic tokens follow project aliases and unsaved buffers', t => {
  const cwd = fixture(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'tsconfig.json'), JSON.stringify({compilerOptions: { paths: { '@lib': ['./src/lib.ts'] } }, include: ['src']}));
  fs.writeFileSync(path.join(cwd, 'src/lib.ts'), 'export function oldName() {}');
  fs.writeFileSync(path.join(cwd, 'src/one.ts'), "import { newName } from '@lib';\nnewName();");
  fs.writeFileSync(path.join(cwd, 'src/two.ts'), "import { newName } from '@lib';\nnewName();");
  const query = {cwd, path:'src/one.ts', line:2, column:3, drafts:[{path:'src/lib.ts',text:'\nexport function newName() {}'}]};
  assert.deepEqual(queryWorkspaceLanguage({...query,kind:'definition'}).locations.map(l => [l.path,l.line,l.column]), [['src/lib.ts',2,17]]);
  assert.ok(queryWorkspaceLanguage({...query,kind:'references'}).locations.some(l => l.path === 'src/two.ts' && l.line === 2));
  assert.ok(queryWorkspaceLanguage({...query,kind:'tokens'}).tokens.length >= 5);
  assert.deepEqual(queryWorkspaceLanguage({...query,kind:'definition',drafts:[]}).locations.filter(l => l.path === 'src/lib.ts'), []);
});

test('a createRequire binding and its call both open the exported CJS declaration; unrelated names stay local', t => {
  const cwd = fixture(t);
  fs.writeFileSync(path.join(cwd,'impl.cjs'), 'function run() {}\nmodule.exports = {run};');
  fs.writeFileSync(path.join(cwd,'main.mjs'), "import {createRequire} from 'node:module';\nconst require = createRequire(import.meta.url);\nconst {run} = require('./impl.cjs');\nrun();\nfunction shadow() { const run = 1; return run; }");
  const query = {cwd, path:'main.mjs', kind:'definition', drafts:[]};
  for (const [line,column] of [[3,9],[4,2]]) {
    const [target] = queryWorkspaceLanguage({...query,line,column}).locations;
    assert.deepEqual([target.path,target.line,target.column], ['impl.cjs',1,10]);
  }
  assert.equal(queryWorkspaceLanguage({...query,line:5,column:44}).locations[0].path,'main.mjs');
});

test('a symlink to another directory cannot return out-of-workspace code', t => {
  const cwd = fixture(t), other = fixture(t);
  fs.writeFileSync(path.join(other,'private.ts'), 'export const hidden = 1;');
  fs.symlinkSync(other, path.join(cwd,'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(cwd,'index.ts'), "import { hidden } from './linked/private';\nhidden;");
  const query = {cwd, path:'index.ts', kind:'definition', line:2, column:3, drafts:[]};
  assert.ok(queryWorkspaceLanguage(query).locations.every(l => l.path === 'index.ts'));
  assert.throws(() => queryWorkspaceLanguage({...query, path:'linked/private.ts'}));
});

test('configured global scripts and changes to inherited path aliases are visible in an open project', t => {
  const cwd = fixture(t);
  for (const name of ['first', 'second']) fs.writeFileSync(path.join(cwd, name + '.ts'), 'export const value = 1;');
  const base = path.join(cwd, 'base.json');
  const config = target => JSON.stringify({compilerOptions: {paths: {'@target': ['./' + target + '.ts']}}});
  fs.writeFileSync(base, config('first'));
  fs.writeFileSync(path.join(cwd, 'tsconfig.json'), '{"extends":"./base.json","include":["*.ts"]}');
  fs.writeFileSync(path.join(cwd, 'globals.ts'), 'function projectWide() {}');
  fs.writeFileSync(path.join(cwd, 'main.ts'), "import {value} from '@target';\nprojectWide();\nvalue;");
  const query = line => queryWorkspaceLanguage({cwd, path:'main.ts', kind:'definition', line, column:2}).locations;
  assert.equal(query(2)[0].path, 'globals.ts');
  assert.equal(query(3)[0].path, 'first.ts');
  fs.writeFileSync(base, config('second'));
  const modified = new Date(Date.now() + 2000);
  fs.utimesSync(base, modified, modified);
  assert.equal(query(3)[0].path, 'second.ts');
});
