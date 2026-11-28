import assert from 'node:assert/strict';
import test from 'node:test';

const {
  browserTabLabel,
  createBrowserGuestTab,
} = await import('../../web/src/features/browser/browser-tab.ts');

test('create and label guest tabs', () => {
  const blank = createBrowserGuestTab({ id: '1' });
  assert.equal(blank.url, 'about:blank');
  assert.equal(browserTabLabel(blank), '新标签页');
  const page = createBrowserGuestTab({ id: '2', url: 'https://example.com/app', title: 'Example' });
  assert.equal(browserTabLabel(page), 'Example');
});
