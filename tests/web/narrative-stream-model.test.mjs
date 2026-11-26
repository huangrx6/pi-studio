import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNarrativeBlocks,
  buildNarrativePhases,
  collectTurnFilePaths,
  computeTurnTiming,
  extractLiveThoughtExcerpt,
  extractThoughtHeadline,
  formatTurnDuration,
  resolveTurnFilePath,
} from '../../web/src/features/conversation/narrative-stream-model.ts';
import { buildTurnContent } from '../../web/src/features/conversation/turn-content.ts';

const text = (value) => ({ type: 'text', text: value });
const thinking = (value, redacted = false) => ({ type: 'thinking', thinking: value, redacted });
const call = (id, name, args = {}) => ({ type: 'toolCall', id, name, arguments: args });
const result = (id, content, isError = false) => [id, { role: 'toolResult', toolCallId: id, content, isError }];
const tinyPng = { type: 'image', mimeType: 'image/png', data: 'AQID' };

test('extractThoughtHeadline filters tiny fragments and extracts a clean clause', () => {
  assert.equal(
    extractThoughtHeadline('## 先核对 `nginx.conf` 的同源反代约束。然后再改前端样式。'),
    '先核对 nginx.conf 的同源反代约束',
  );
  assert.equal(extractThoughtHeadline('没有 CSP'), '');
  const longText = '第一句思考说明非常长，用来验证流式焦点窗在长推理时只保留最后一段核心内容，不会把整个聊天窗口撑爆。'.repeat(4);
  const excerpt = extractLiveThoughtExcerpt(longText, 80);
  assert.ok(excerpt.startsWith('…'));
  assert.ok(excerpt.length <= 84);
});

test('buildNarrativeBlocks preserves strict chronology and binds verification screenshots to work blocks', () => {
  const results = new Map([
    result('read-1', [text('ok')]),
    result('shot-1', [text('captured'), tinyPng]),
    result('gen-1', [tinyPng]),
  ]);
  const built = buildTurnContent([
    {
      role: 'assistant',
      content: [
        call('read-1', 'read', { path: 'nginx.conf' }),
        text('我已核对完反代配置，下面开始截图验收。'),
        call('shot-1', 'browser_screenshot', {}),
        call('gen-1', 'generate_image', { prompt: 'banner' }),
        text('全部完成。'),
      ],
    },
  ], results, false);

  const blocks = buildNarrativeBlocks(built.segments);
  assert.deepEqual(blocks.map((block) => block.kind), ['work', 'text', 'work', 'images', 'text']);
  assert.equal(blocks[2].kind, 'work');
  assert.equal(blocks[2].toolImages.get('shot-1')?.length, 1);
  assert.equal(blocks[3].kind, 'images');
});

test('buildNarrativePhases formats structured file/search/edit/command steps and merges verify loops', () => {
  const results = new Map([
    result('g1', [text('match')]),
    result('r1', [text('content')]),
    result('w1', [text('written')]),
    result('s1', [tinyPng]),
    result('c1', [text('ok')]),
    result('s2', [tinyPng]),
  ]);
  const built = buildTurnContent([
    {
      role: 'assistant',
      content: [
        call('g1', 'grep', { path: 'src/render.py', pattern: 'preview|sandbox' }),
        call('r1', 'read', { path: 'docs/mockups.md' }),
        call('w1', 'write', { path: 'chat-progress-preview.html', content: 'a\nb\nc' }),
        call('s1', 'browser_screenshot', {}),
        call('c1', 'bash', { command: 'curl -s localhost:8080' }),
        call('s2', 'browser_screenshot', {}),
      ],
    },
  ], results, false);

  const blocks = buildNarrativeBlocks(built.segments);
  const phases = buildNarrativePhases(blocks[0].entries, results, blocks[0].toolImages);

  assert.equal(phases.length, 3);
  assert.equal(phases[0].steps[0].prefix, '已在');
  assert.equal(phases[0].steps[0].fileLabel, 'src/render.py');
  assert.equal(phases[0].steps[0].detail, '中搜索“preview|sandbox”');
  assert.equal(phases[0].steps[1].prefix, '已读取');
  assert.equal(phases[0].steps[1].fileLabel, 'docs/mockups.md');

  assert.equal(phases[1].steps[0].prefix, '已创建');
  assert.equal(phases[1].steps[0].fileLabel, 'chat-progress-preview.html');
  assert.deepEqual(phases[1].steps[0].diff, { added: 3, removed: 0 });

  assert.equal(phases[2].category, 'verify');
  assert.equal(phases[2].imageCount, 2);
});

test('resolveTurnFilePath resolves nested relative paths from prose to the exact file touched in the turn', () => {
  const cwd = '/Users/demo/workspace/misc';
  const messages = [{
    role: 'assistant',
    content: [
      call('w1', 'write', { path: `${cwd}/dsh-workbench/docs/PLAN.md` }),
      call('w2', 'write', { path: `${cwd}/dsh-workbench/package.json` }),
      call('w3', 'write', { path: `${cwd}/dsh-workbench/apps/server/package.json` }),
    ],
  }];
  const paths = collectTurnFilePaths(messages);
  assert.equal(resolveTurnFilePath('docs/PLAN.md', paths, cwd), `${cwd}/dsh-workbench/docs/PLAN.md`);
  assert.equal(resolveTurnFilePath('./docs/PLAN.md', paths, cwd), `${cwd}/dsh-workbench/docs/PLAN.md`);
  assert.equal(resolveTurnFilePath('PLAN.md', paths, cwd), `${cwd}/dsh-workbench/docs/PLAN.md`);
  // Ambiguous bare filename does not guess blindly, while qualified subpath resolves cleanly.
  assert.equal(resolveTurnFilePath('package.json', paths, cwd), undefined);
  assert.equal(resolveTurnFilePath('apps/server/package.json', paths, cwd), `${cwd}/dsh-workbench/apps/server/package.json`);
});

test('computeTurnTiming and formatTurnDuration calculate elapsed duration for the turn accurately', () => {
  const start = 1_700_000_000_000;
  const end = start + 137_000; // 2m 17s
  const messages = [
    { role: 'assistant', timestamp: start + 12_000, content: [call('c1', 'bash', { command: 'ls' })] },
    { role: 'assistant', timestamp: end, content: [text('done')] },
  ];
  const results = new Map([['c1', { role: 'toolResult', toolCallId: 'c1', timestamp: start + 25_000, content: [text('ok')] }]]);

  const timing = computeTurnTiming(messages, results, [{ createdAt: start + 1_000 }], start);
  assert.equal(timing.startMs, start);
  assert.equal(timing.endMs, end);
  assert.equal(formatTurnDuration(timing.endMs - timing.startMs), '用时 2分 17秒');

  // Queued message waiting >60s before execution measures from first provider request.
  const queuedTiming = computeTurnTiming(messages, results, [{ createdAt: start + 1_000 }], start - 180_000);
  assert.equal(queuedTiming.startMs, start + 1_000);
  assert.equal(formatTurnDuration(18_400), '用时 18秒');
  assert.equal(formatTurnDuration(3_900_000), '用时 1小时 5分');
  assert.equal(formatTurnDuration(200), '');
});

test('live streaming respects browser_type privacy and redacted thinking', () => {
  const built = buildTurnContent([
    {
      role: 'assistant',
      content: [
        thinking('敏感内部推理', true),
        call('t1', 'browser_type', { text: 'secret-token' }),
      ],
    },
  ], new Map(), true);

  const blocks = buildNarrativeBlocks(built.segments);
  const phases = buildNarrativePhases(blocks[0].entries, new Map(), blocks[0].toolImages);
  assert.equal(phases.length, 1);
  assert.equal(phases[0].steps[1].prefix, '正在填写网页表单');
  const renderedText = [
    phases[0].headline,
    ...phases[0].steps.flatMap((step) => [step.prefix, step.fileLabel, step.detail, step.liveThoughtExcerpt]),
  ].filter(Boolean).join(' ');
  assert.doesNotMatch(renderedText, /secret-token|敏感内部推理/);
});
