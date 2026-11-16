import assert from 'node:assert/strict';
import test from 'node:test';
import { webAction, webSources } from '../../web/src/features/conversation/web-sources.ts';

const call = (name, id = 'one', args = {}) => ({ type: 'toolCall', name, id, arguments: args });
const result = (text = '', details) => ({ role: 'toolResult', content: [{ type: 'text', text }], details });

test('source chips come from successful web tools, scoped to their own results and grouped by host', () => {
  const calls = [call('mcp__brave__brave_web_search'), call('mcp__exa__web_search_exa', 'two'), call('webSearch', 'failed'), call('web_search', 'pending')];
  const results = new Map([
    ['one', result('https://unrelated.example', { structuredContent: { web: { results: [
      { title: '第一篇', url: 'https://example.org/one', description: 'https://other.example' },
      { title: '第二篇', url: 'https://example.org/two' }, { url: 'javascript:alert(1)' },
      { url: 'https://u:p@private.example/' },
    ] } } })],
    ['two', result('[{"url":"https://docs.example.org/article"}]')],
    ['failed', { ...result('URL: https://failure.example'), isError: true }],
  ]);
  assert.deepEqual(webSources(calls, results).map(s => [s.host, s.href]), [
    ['example.org', 'https://example.org/one'], ['docs.example.org', 'https://docs.example.org/article'],
  ]);
  assert.equal(webAction(call('mcp__filesystem__search')), undefined);
  assert.deepEqual(webSources([call('bash')], results), []);
});

test('Markdown and labelled results are clickable; fetched page body links are not attributed', () => {
  const r = result('- [MDN](https://developer.mozilla.org/docs)\nURL: https://web.dev/articles\nA snippet mentioning https://other.example');
  assert.equal(webSources([call('tavily_search')], new Map([['one', r]])).length, 2);
  const fetch = call('mcp__fetch__fetch', 'one', { url: 'https://example.org/read' });
  assert.deepEqual(webSources([fetch], new Map([['one', r]])).map(s => s.href), ['https://example.org/read']);
  assert.deepEqual(webSources([fetch], new Map()), []);
});
