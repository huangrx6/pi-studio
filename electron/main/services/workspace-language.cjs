const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const libDir = path.dirname(require.resolve('typescript'));
const legacyData = path.join(os.homedir(), '.pi');
const sourcePattern = /\.[cm]?[jt]sx?$/i;
const generated = ['node_modules', '.git', '.pi', '.pi-studio', '.pnpm-store', '.qa', 'dist', 'build', 'release', 'coverage', 'vendor'];
const projects = new Map();

function inside(root, file) {
  const relative = path.relative(root, file);
  return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

// TypeScript resolves config inheritance, imports and symlinks through this host.
// Only bundled standard declarations may be read outside the selected worktree.
function projectSystem(root) {
  const paths = new Map();
  const stats = new Map();
  const asTypeScriptPath = file => file.split(path.sep).join('/');
  function permitted(file) {
    return !inside(legacyData, file) && (inside(root, file) || file === libDir ||
      (path.dirname(file) === libDir && /^lib\..*\.d\.ts$/i.test(path.basename(file))));
  }
  function resolve(file) {
    const absolute = path.resolve(root, file);
    if (paths.has(absolute)) return paths.get(absolute);
    let result;
    if (permitted(absolute)) {
      try {
        const real = fs.realpathSync(absolute);
        if (permitted(real)) result = real;
      } catch { /* A missing import is a normal lookup. */ }
    }
    paths.set(absolute, result);
    return result;
  }
  function stat(file) {
    const real = resolve(file);
    if (!real) return undefined;
    if (!stats.has(real)) {
      let value;
      try { value = fs.statSync(real); } catch { /* Removed since path resolution. */ }
      stats.set(real, value);
    }
    return stats.get(real);
  }
  function entries(directory) {
    const result = { files: [], directories: [] };
    const real = resolve(directory);
    if (real) {
      let list;
      try { list = fs.readdirSync(real, { withFileTypes: true }); } catch { return result; }
      for (const entry of list) {
        if (entry.isDirectory() && !generated.includes(entry.name)) result.directories.push(entry.name);
        else if (entry.isFile()) result.files.push(entry.name);
      }
    }
    return result;
  }
  return {
    stat,
    reset() { paths.clear(); stats.clear(); },
    workspacePath(file) {
      const real = resolve(file);
      return real && inside(root, real) ? asTypeScriptPath(real) : undefined;
    },
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: file => Boolean(stat(file)?.isFile()),
    directoryExists: file => Boolean(stat(file)?.isDirectory()),
    realpath: file => asTypeScriptPath(resolve(file) ?? file),
    getDirectories: directory => entries(directory).directories,
    readFile(file) {
      const real = resolve(file);
      if (!real) return undefined;
      const info = stat(real);
      if (info?.isFile() && info.size <= 8 * 1024 * 1024) return ts.sys.readFile(real);
    },
    readDirectory: (dir, extensions, exclude, include, depth) => ts.matchFiles(dir, extensions, exclude, include,
      ts.sys.useCaseSensitiveFileNames, root, depth, entries, file => resolve(file) ?? file),
  };
}

function nearestConfig(root, file, system) {
  for (let dir = path.dirname(file); inside(root, dir); dir = path.dirname(dir)) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const config = path.join(dir, name);
      if (system.fileExists(config)) return config;
    }
    if (dir === root) break;
  }
}

function createProject(root, config, system) {
  const defaults = { allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const configVersions = new Map();
  function readConfig(file) {
    configVersions.set(file, system.stat(file)?.mtimeMs);
    return system.readFile(file);
  }
  function parseConfig() {
    if (!config) return undefined;
    const data = ts.readConfigFile(config, readConfig).config;
    return data && ts.parseJsonConfigFileContent(data, { ...system, readFile: readConfig }, path.dirname(config), undefined, config);
  }
  let parsed = parseConfig();
  const options = { ...(parsed?.options ?? defaults), allowJs: true, noEmit: true };
  let roots = [];
  let overlays = new Map();
  let version = 0;
  let projectVersion = 0;
  const host = {
    ...system,
    useCaseSensitiveFileNames: () => system.useCaseSensitiveFileNames,
    getCompilationSettings: () => options,
    getCurrentDirectory: () => root,
    getProjectVersion: () => String(projectVersion),
    getDefaultLibFileName: opts => ts.getDefaultLibFilePath(opts),
    getScriptFileNames: () => roots,
    getScriptVersion(file) {
      if (overlays.has(file)) return 'draft:' + overlays.get(file).version;
      const stat = system.stat(file);
      return stat ? `${stat.mtimeMs}/${stat.size}` : '';
    },
    getScriptSnapshot(file) {
      const text = overlays.get(file)?.text ?? system.readFile(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
  };
  const service = ts.createLanguageService(host);
  function prepare(file, drafts, references) {
    projectVersion++;
    system.reset();
    if (references) parsed = parseConfig();
    const previous = overlays;
    overlays = new Map();
    for (const draft of drafts) {
      const absolute = system.workspacePath(draft.path);
      if (absolute && sourcePattern.test(absolute)) {
        const old = previous.get(absolute);
        overlays.set(absolute, old?.text === draft.text ? old : { text: draft.text, version: ++version });
      }
    }
    const configured = parsed?.fileNames ?? [];
    // Imports are followed on demand. A reference search also needs unopened callers.
    let files = configured;
    if (!configured.includes(file)) {
      files = references
        ? system.readDirectory(root, ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.mts', '.cts'],
          ['**/*.min.js', ...generated], ['**/*']).filter(name => !/[/\\]assets[/\\][^/\\]+-[\w-]{8}\.js$/.test(name))
        : configured.filter(name => /\.d\.[cm]?ts$/i.test(name));
    }
    roots = [...new Set([file, ...overlays.keys(), ...files])];
  }
  return { service, prepare, configChanged(fresh) {
    return [...configVersions].some(([file, stamp]) => fresh.stat(file)?.mtimeMs !== stamp);
  } };
}

function definitions(service, source, offset) {
  const direct = service.getDefinitionAtPosition(source.fileName, offset);
  if (direct?.length) return direct;
  // At the declaration in `const { name } = require('./module.cjs')` TS can
  // resolve calls to name but omit the binding itself. Use the resolved module's
  // export symbol, including shorthand exports and renamed destructuring.
  const node = ts.getTokenAtPosition(source, offset);
  const binding = node.parent;
  if (!ts.isBindingElement(binding) || !ts.isVariableDeclaration(binding.parent.parent)) return [];
  const call = binding.parent.parent.initializer;
  if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'require' ||
      call.arguments.length !== 1 || !ts.isStringLiteral(call.arguments[0])) return [];
  const program = service.getProgram();
  const resolved = program.getResolvedModuleFromModuleSpecifier(call.arguments[0], source)?.resolvedModule;
  const module = resolved && program.getSourceFile(resolved.resolvedFileName);
  if (!module?.symbol) return [];
  const checker = program.getTypeChecker();
  const exported = checker.getExportsOfModule(module.symbol).find(symbol => symbol.name === (binding.propertyName ?? binding.name).getText(source));
  const locations = [];
  for (const declaration of exported?.declarations ?? []) {
    const value = ts.isShorthandPropertyAssignment(declaration) ? checker.getShorthandAssignmentValueSymbol(declaration)?.valueDeclaration : declaration;
    if (value?.name) locations.push({ fileName: value.getSourceFile().fileName, textSpan: { start: value.name.getStart(), length: value.name.getWidth() } });
  }
  return locations;
}

function queryWorkspaceLanguage(request) {
  const { cwd, path: relative, kind, drafts = [] } = request;
  if (!['definition', 'references', 'tokens'].includes(kind) || typeof relative !== 'string' || !sourcePattern.test(relative)) throw new Error('不支持此源码查询');
  if (inside(legacyData, cwd)) throw new Error('文件不在可读取的工作区内');
  const root = fs.realpathSync(cwd);
  const system = projectSystem(root);
  const file = system.workspacePath(relative);
  if (!file) throw new Error('文件不在可读取的工作区内');
  const config = nearestConfig(root, file, system);
  const key = JSON.stringify([root, config]);
  let project = projects.get(key);
  if (!project || project.configChanged(system)) {
    project?.service.dispose();
    project = createProject(root, config, system);
  }
  projects.delete(key);
  projects.set(key, project);
  if (projects.size > 3) {
    const [oldKey, old] = projects.entries().next().value;
    old.service.dispose();
    projects.delete(oldKey);
  }
  project.prepare(file, drafts, kind === 'references');
  const service = project.service;
  const program = service.getProgram();
  const source = program?.getSourceFile(file);
  if (!source) throw new Error('无法读取项目源码');
  if (kind === 'tokens') {
    const { spans } = service.getEncodedSemanticClassifications(file, { start: 0, length: source.getFullWidth() }, ts.SemanticClassificationFormat.TwentyTwenty);
    const tokens = [];
    let prevLine = 0, prevChar = 0;
    for (let i = 0; i < spans.length; i += 3) {
      const { line, character } = source.getLineAndCharacterOfPosition(spans[i]);
      const type = (spans[i + 2] >> 8) - 1;
      if (type < 0) continue;
      tokens.push(line - prevLine, line === prevLine ? character - prevChar : character, spans[i + 1], type, 0);
      prevLine = line;
      prevChar = character;
    }
    return { tokens };
  }
  const { line, column } = request;
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1 || line > source.getLineStarts().length) return { locations: [] };
  const offset = source.getPositionOfLineAndCharacter(line - 1, column - 1, true);
  const matches = kind === 'definition' ? definitions(service, source, offset) : service.getReferencesAtPosition(file, offset);
  const locations = [];
  for (const match of matches ?? []) {
    if (!inside(root, match.fileName) || inside(legacyData, match.fileName)) continue;
    const target = program.getSourceFile(match.fileName);
    if (!target) continue;
    const start = target.getLineAndCharacterOfPosition(match.textSpan.start);
    const end = target.getLineAndCharacterOfPosition(match.textSpan.start + match.textSpan.length);
    locations.push({ path: path.relative(root, match.fileName).split(path.sep).join('/'), line: start.line + 1,
      column: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1 });
  }
  return { locations };
}
module.exports = { queryWorkspaceLanguage };
