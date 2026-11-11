/**
 * Local-path detection behind the clickable file links in chat markdown.
 *
 * The detector decides whether a token becomes a link, so the cases below pin
 * both directions: real deliverables must link, prose and URLs must not.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { pathToken, resolvePathToken, trimPathPunctuation } = await import('../../web/src/shared/file-path-links.mjs');
const rehypeLocalPaths = (await import('../../web/src/shared/rehype-local-paths.mjs')).default;

test('links deliverable paths in the shapes the model writes', () => {
  for (const value of [
    'travel/一周旅游计划.md',
    '一周旅游计划.md',
    '/Users/me/report.pdf',
    '~/notes/x.md',
    'docflux-20261104-code-linux-amd64-upgrade.zip',
    'docker-compose.yml',
    'travel/',
  ]) {
    assert.equal(pathToken(value), value, value);
  }
});

test('leaves prose, URLs, schemes and bare words alone', () => {
  for (const value of [
    'SHA-256',
    '校验文件',
    'readme',
    'https://example.com/a.md',
    'mailto:someone@example.com',
    'node:24-alpine',
    'a b.md',
    '见 travel/x.md',
    '-',
    '/',
  ]) {
    assert.equal(pathToken(value), null, value);
  }
});

test('trims prose punctuation but keeps the path intact', () => {
  assert.equal(trimPathPunctuation('a.md。'), 'a.md');
  assert.equal(trimPathPunctuation('travel/x.md,'), 'travel/x.md');
  assert.equal(pathToken('一周旅游计划.md。'), '一周旅游计划.md');
});

test('resolves relative tokens against the conversation cwd', () => {
  assert.equal(resolvePathToken('travel/x.md', '/repo'), '/repo/travel/x.md');
  assert.equal(resolvePathToken('./travel/x.md', '/repo'), '/repo/travel/x.md');
  assert.equal(resolvePathToken('../x.md', '/repo/sub'), '/repo/x.md');
  assert.equal(resolvePathToken('/abs/x.md', '/repo'), '/abs/x.md');
  assert.equal(resolvePathToken('~/x.md', '/repo'), '~/x.md');
});

test('the rehype plugin links inline code and prose, never code blocks', () => {
  const text = (value) => ({ type: 'text', value });
  const code = (value) => ({ type: 'element', tagName: 'code', properties: {}, children: [text(value)] });
  const tree = {
    type: 'root',
    children: [{
      type: 'element',
      tagName: 'p',
      properties: {},
      children: [text('见 '), code('travel/一周旅游计划.md'), text(' 与 '), text('notes/a.txt'), text('，不要改 main.tsx?')],
    }, {
      type: 'element',
      tagName: 'pre',
      properties: {},
      children: [code('build/artifact.zip')],
    }],
  };
  rehypeLocalPaths()(tree);
  const paragraph = tree.children[0].children;
  const links = paragraph.filter((node) => node.type === 'element' && node.tagName === 'a');
  // `main.tsx?` keeps the file and drops the prose question mark.
  assert.deepEqual(links.map((link) => link.properties.dataPath), ['travel/一周旅游计划.md', 'notes/a.txt', 'main.tsx']);
  assert.equal(links[0].children[0].tagName, 'code', 'inline code keeps its element');
  // Code blocks stay verbatim.
  const pre = tree.children[1];
  assert.equal(pre.children[0].tagName, 'code');
  assert.ok(!JSON.stringify(pre).includes('dataPath'));
});

test('中文文件名与裸产物名都会被识别成可打开的文件链接', () => {
  assert.equal(pathToken('AI提效工作情况汇报-代码开发方向.docx'), 'AI提效工作情况汇报-代码开发方向.docx');
  assert.equal(pathToken('gen_ai_report_docx.py'), 'gen_ai_report_docx.py');
  assert.equal(pathToken('output/AI提效工作情况汇报.docx'), 'output/AI提效工作情况汇报.docx');
  // 只在句子里出现、又不是文件名的中文词保持原样。
  assert.equal(pathToken('文档已经生成'), null);
});
