const assert = require('node:assert/strict');
const test = require('node:test');

const { trimSnapshot } = require('../../electron/main/services/browser/snapshot.cjs');

test('trimSnapshot keeps small payloads intact', () => {
  const snapshot = trimSnapshot({
    url: 'https://example.com',
    title: 'Example',
    refs: { e1: { role: 'button', name: 'OK' } },
    tree: [{ ref: 'e1', role: 'button', name: 'OK' }],
    omittedCount: 0,
  }, 12_000);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.url, 'https://example.com');
  assert.equal(snapshot.refs.e1.name, 'OK');
  assert.ok(snapshot.charCount > 0);
});

test('trimSnapshot compacts oversized trees', () => {
  const refs = {};
  const tree = [];
  for (let i = 1; i <= 120; i += 1) {
    const ref = `e${i}`;
    refs[ref] = { role: 'link', name: `Item ${i} ${'x'.repeat(80)}`, value: 'y'.repeat(80) };
    tree.push({ ref, role: 'link', name: refs[ref].name, children: [{ ref: `${ref}c`, role: 'text', name: 'child' }] });
  }
  const snapshot = trimSnapshot({ url: 'https://example.com/long', title: 'Long', refs, tree, omittedCount: 10 }, 4_000);
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.charCount <= 4_000);
  assert.ok(Object.keys(snapshot.refs).length <= 80);
  assert.ok(Array.isArray(snapshot.warnings));
  assert.ok(snapshot.warnings.some((item) => /truncat|compact/i.test(item)));
});

const { buildSnapshotScript } = require('../../electron/main/services/browser/snapshot.cjs');

test('buildSnapshotScript stamps refs and supports a11y mode', () => {
  const domLite = buildSnapshotScript({ mode: 'dom_lite', maxNodes: 50 });
  assert.match(domLite, /data-pi-ref/);
  assert.match(domLite, /iframe:cross-origin omitted/);
  const a11y = buildSnapshotScript({ mode: 'a11y', maxNodes: 50 });
  assert.match(a11y, /mode === 'a11y'/);
  assert.match(a11y, /a11yInteresting|tabIndex/);
});

test('trimSnapshot preserves mode and warnings', () => {
  const snapshot = trimSnapshot({
    url: 'https://example.com',
    title: 'Example',
    mode: 'a11y',
    refs: { e1: { role: 'button', name: 'OK' } },
    tree: [{ ref: 'e1', role: 'button', name: 'OK' }],
    warnings: ['iframe:cross-origin omitted'],
    stampedCount: 1,
  }, 12_000);
  assert.equal(snapshot.mode, 'a11y');
  assert.deepEqual(snapshot.warnings, ['iframe:cross-origin omitted']);
  assert.equal(snapshot.stampedCount, 1);
});
