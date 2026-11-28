import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const markdown = `# Atlas Notes

用 Markdown 记录想法，通过标题和标签找回笔记。笔记和搜索索引均保存在本地。

## 搜索索引

每次保存笔记，Atlas Notes 都会更新对应的索引条目。标题和标签共用一个搜索框。

| 字段 | 索引规则 |
| --- | --- |
| \`title\` | 忽略大小写匹配，展示时保留原标题 |
| \`tags\` | 去掉开头的 #，转为小写并去重 |
| \`updatedAt\` | 匹配程度相同时，最近编辑的笔记优先 |

## 匹配顺序

1. 标题完整匹配。
2. 标题包含关键词。
3. 标签完整匹配。

> 输入 \`#design\` 即可按标签查找笔记。
`;

export async function prepareAtlasWorkspace(mainTree, tagTree) {
  await mkdir(mainTree);
  for (const [name, content] of Object.entries({
    'README.md': markdown,
    'notes/design-notes.md': '# Design Notes\n\n标签：#design\n',
    'src/search.mjs': 'export const normalizeTag = tag => tag.toLowerCase().replace(/^#/, "");\n',
    'tests/search.test.mjs': 'import assert from "node:assert/strict";\nimport { normalizeTag } from "../src/search.mjs";\nassert.equal(normalizeTag("#Design"), "design");\n',
    'CHANGELOG.md': '# 更新记录\n\n支持按标签查找笔记。\n',
  })) {
    await mkdir(path.dirname(path.join(mainTree, name)), { recursive: true });
    await writeFile(path.join(mainTree, name), content);
  }
  const git = (...args) => execFileSync('git', ['-C', mainTree, '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Atlas Notes', '-c', 'user.email=atlas@example.invalid', ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('add', '.');
  git('commit', '-m', 'Index Markdown notes');
  git('worktree', 'add', '-b', 'feat/tag-search', tagTree);
}
