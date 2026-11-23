import assert from 'node:assert/strict';
import test from 'node:test';

const {
  browserTabLabel,
  closeBrowserGuestTab,
  createBrowserGuestTab,
  upsertBrowserGuestTab,
} = await import('../../web/src/shell/right-panel/browser/browser-tabs.ts');

test('create and label guest tabs', () => {
  const blank = createBrowserGuestTab({ id: '1' });
  assert.equal(blank.url, 'about:blank');
  assert.equal(browserTabLabel(blank), '新标签页');
  const page = createBrowserGuestTab({ id: '2', url: 'https://example.com/app', title: 'Example' });
  assert.equal(browserTabLabel(page), 'Example');
});

test('upsert reuses matching url and close keeps a blank tab', () => {
  let state = upsertBrowserGuestTab([], { url: 'https://a.test/', createId: () => 'a' });
  state = upsertBrowserGuestTab(state.tabs, { url: 'https://a.test/', createId: () => 'b' });
  assert.equal(state.tabs.length, 1);
  assert.equal(state.activeId, 'a');
  state = upsertBrowserGuestTab(state.tabs, { url: 'https://b.test/', createId: () => 'b' });
  assert.equal(state.tabs.length, 2);
  state = closeBrowserGuestTab(state.tabs, 'b', 'a', () => 'blank');
  assert.equal(state.tabs.length, 1);
  assert.equal(state.activeId, 'b');
  state = closeBrowserGuestTab(state.tabs, 'b', 'b', () => 'blank');
  assert.equal(state.tabs[0].id, 'blank');
  assert.equal(state.tabs[0].url, 'about:blank');
});
