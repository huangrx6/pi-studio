import assert from 'node:assert/strict';
import test from 'node:test';
import { hasMarkdownCode, messagesHaveMarkdownCode } from '../../web/src/shared/markdown-code.mjs';

test('fenced and indented code request syntax highlighting', () => {
  assert.equal(hasMarkdownCode('text\n```ts\nconst value = 1;\n```'), true);
  assert.equal(hasMarkdownCode('~~~json\n{"ok":true}\n~~~'), true);
  assert.equal(hasMarkdownCode('    const value = 1;'), true);
  assert.equal(hasMarkdownCode('\tconst value = 1;'), true);
  assert.equal(hasMarkdownCode('> ```sh\n> npm test\n> ```'), true);
  assert.equal(hasMarkdownCode('>     const quoted = true;'), true);
});

test('ordinary prose, inline code and loose indentation do not load the highlighter', () => {
  assert.equal(hasMarkdownCode('普通回答，只有一个 `inline` 标记。'), false);
  assert.equal(hasMarkdownCode('A sentence with ``` inside prose.'), false);
  assert.equal(hasMarkdownCode('   indented prose without code'), false);
  assert.equal(hasMarkdownCode('## 标题\n\n- 列表\n- 内容'), false);
});

test('message prefetch ignores tool output and sees assistant text or thinking code', () => {
  const text = (value) => ({ type: 'text', text: value });
  const thinking = (value) => ({ type: 'thinking', thinking: value });
  assert.equal(messagesHaveMarkdownCode([
    { content: [text('普通回答')] },
    { content: [{ type: 'toolResult', text: '```sh\necho tool-only\n```' }] },
  ]), false);
  assert.equal(messagesHaveMarkdownCode([{ content: [text('```ts\nconst value = 1;\n```')] }]), true);
  assert.equal(messagesHaveMarkdownCode([{ content: [thinking('    const planned = true;')] }]), true);
});
