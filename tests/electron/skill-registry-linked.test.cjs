const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');

installElectronSafeStorage(test);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-skill-linked-'));
process.env.PI_STUDIO_USER_DATA = path.join(temporary, 'user-data');
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const { closeStudioDatabase } = require('../../electron/core/studio-db.cjs');
const {
  installPreparedSkill,
  prepareSkillInstall,
  removeSkillSource,
  saveSkillSource,
  skillHubSnapshot,
  __test,
} = require('../../electron/capabilities/skills/index.cjs');
const { parseGithubLink } = require('../../electron/capabilities/skills/linked-source.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function writeRegistry(name, payload) {
  const directory = path.join(temporary, name);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'catalog.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

test('link catalogs load without a schemaVersion and skip broken entries', async () => {
  const source = saveSkillSource({
    type: 'registry',
    name: '链接清单',
    location: writeRegistry('links', {
      total: 4,
      skills: [
        { name: 'release-notes', url: 'https://github.com/example/skills/tree/main/skills/release-notes/SKILL.md', description: 'Write release notes.' },
        { name: 'release-notes', url: 'https://github.com/example/skills/tree/main/skills/other/SKILL.md', description: 'Duplicate name.' },
        { name: 'Bad Name', url: 'https://github.com/example/skills/tree/main/skills/bad/SKILL.md', description: 'Invalid skill name.' },
        { name: '中文技能', url: 'https://github.com/example/skills/tree/main/skills/zh/SKILL.md', description: '中文说明' },
      ],
    }),
  });
  const { entries, diagnostics } = await __test.readRegistry(saveSkillSource({ ...source, id: source.id }));
  assert.deepEqual(entries.map((entry) => entry.name), ['release-notes']);
  assert.equal(entries[0].link, 'https://github.com/example/skills/tree/main/skills/release-notes/SKILL.md');
  assert.equal(entries[0].version, '');
  assert.equal(diagnostics.length, 3);
  assert.match(diagnostics[0].message, /名称重复/);
  assert.match(diagnostics[1].message, /名称无效/);
  assert.match(diagnostics[2].message, /名称无效/);
  removeSkillSource(source.id);
});

test('unknown registry schema versions name the supported shapes', async () => {
  const source = {
    id: 'schema-check',
    type: 'registry',
    location: writeRegistry('schema-3', { schemaVersion: 3, skills: [] }),
  };
  await assert.rejects(__test.readRegistry(source), /仅支持 schemaVersion 1 或 2/);
});

test('linked registries install the referenced skill and its sibling files', async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
    removeSkillSource(sourceId);
  });
  const skillMarkdown = [
    '---',
    'name: linked-demo',
    'description: A linked skill.',
    'metadata:',
    '  version: 3.1.0',
    '---',
    '',
    'Use the linked workflow.',
    '',
  ].join('\n');
  const requests = [];
  global.fetch = async (url) => {
    const target = String(url);
    requests.push(target);
    if (target === 'https://raw.githubusercontent.com/example/skills/main/skills/linked-demo/SKILL.md') {
      return new Response(skillMarkdown, { status: 200 });
    }
    if (target === 'https://api.github.com/repos/example/skills/contents/skills/linked-demo?ref=main') {
      return Response.json([
        { type: 'file', path: 'skills/linked-demo/SKILL.md', size: skillMarkdown.length, download_url: 'https://raw.githubusercontent.com/example/skills/main/skills/linked-demo/SKILL.md' },
        { type: 'file', path: 'skills/linked-demo/references/guide.md', size: 12, download_url: 'https://raw.githubusercontent.com/example/skills/main/skills/linked-demo/references/guide.md' },
      ]);
    }
    if (target === 'https://raw.githubusercontent.com/example/skills/main/skills/linked-demo/references/guide.md') {
      return new Response('guide content', { status: 200 });
    }
    return new Response('', { status: 404 });
  };

  const sourceId = saveSkillSource({
    type: 'registry',
    name: 'GitHub 链接清单',
    location: writeRegistry('linked', {
      skills: [{
        name: 'linked-demo',
        description: 'A linked skill.',
        url: 'https://github.com/example/skills/tree/main/skills/linked-demo/SKILL.md',
      }],
    }),
  }).id;
  const hub = await skillHubSnapshot({ refresh: true });
  const item = hub.catalogs.find((catalog) => catalog.source.id === sourceId).items[0];
  const preview = await prepareSkillInstall({ sourceId, listingId: item.listingId, scope: 'user' });
  assert.equal(preview.version, '3.1.0');
  assert.deepEqual(preview.files.map((file) => file.path).sort(), ['SKILL.md', 'references/guide.md']);
  const installed = installPreparedSkill({ token: preview.token });
  assert.equal(fs.readFileSync(path.join(installed.baseDir, 'references', 'guide.md'), 'utf8'), 'guide content');
  assert.ok(requests.some((url) => url.includes('/contents/skills/linked-demo?ref=main')));
});

test('a dead link reports the missing file instead of a network stack trace', async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
    removeSkillSource(sourceId);
  });
  global.fetch = async () => new Response('', { status: 404 });
  const sourceId = saveSkillSource({
    type: 'registry',
    name: '失效链接',
    location: writeRegistry('dead', {
      skills: [{ name: 'gone-skill', description: 'Dead link.', url: 'https://github.com/example/skills/tree/main/skills/gone/SKILL.md' }],
    }),
  }).id;
  const hub = await skillHubSnapshot({ refresh: true });
  const item = hub.catalogs.find((catalog) => catalog.source.id === sourceId).items[0];
  await assert.rejects(
    prepareSkillInstall({ sourceId, listingId: item.listingId, scope: 'user' }),
    /链接可能已失效/,
  );
});

test('GitHub links keep branch names with slashes intact', () => {
  assert.deepEqual(
    parseGithubLink('https://github.com/example/skills/tree/feature/nested/skills/demo/SKILL.md'),
    { owner: 'example', repo: 'skills', rest: ['feature', 'nested', 'skills', 'demo', 'SKILL.md'] },
  );
  assert.equal(parseGithubLink('https://example.com/skills/demo/SKILL.md'), null);
  assert.equal(parseGithubLink('https://github.com/example/skills'), null);
});
