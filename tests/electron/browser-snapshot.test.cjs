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

const { buildSnapshotScript, formatSnapshotOutline } = require('../../electron/main/services/browser/snapshot.cjs');

test('buildSnapshotScript compiles valid JS across all modes and options', () => {
  const domLite = buildSnapshotScript({ mode: 'dom_lite', maxNodes: 50 });
  assert.doesNotThrow(() => new Function(domLite), 'dom_lite script must be valid JS');
  assert.match(domLite, /data-pi-ref/);
  assert.match(domLite, /iframe:cross-origin omitted/);
  assert.match(domLite, /shadowRoot/);

  const a11y = buildSnapshotScript({ mode: 'a11y', maxNodes: 50, viewportOnly: true, selector: 'main' });
  assert.doesNotThrow(() => new Function(a11y), 'a11y viewportOnly script must be valid JS');
  assert.match(a11y, /mode === 'a11y'/);
  assert.match(a11y, /a11yInteresting|tabIndex/);
  assert.match(a11y, /viewportOnly = true/);

  const textMode = buildSnapshotScript({ mode: 'text', maxChars: 6000, viewportOnly: true, selector: 'article' });
  assert.doesNotThrow(() => new Function(textMode), 'text mode script must be valid JS');
  assert.match(textMode, /mode: 'text'/);
  assert.match(textMode, /formatTable/);
});

test('formatSnapshotOutline produces compact single-pass outline without duplicating refs JSON', () => {
  const outline = formatSnapshotOutline({
    refs: {
      e1: { role: 'heading', name: 'field-sizing' },
      e2: { role: 'textbox', name: 'Search', value: 'css', states: ['required'] },
      e3: { role: 'button', name: 'Go', states: ['disabled'] },
    },
    tree: [{
      role: 'group',
      children: [
        { ref: 'e1', role: 'heading', name: 'field-sizing' },
        { ref: 'e2', role: 'textbox', name: 'Search', value: 'css', states: ['required'] },
        { ref: 'e3', role: 'button', name: 'Go', states: ['disabled'] },
      ],
    }],
  }, 2000);
  assert.match(outline, /- heading "field-sizing" \[e1\]/);
  assert.match(outline, /- textbox "Search" \[e2\] val="css" \(required\)/);
  assert.match(outline, /- button "Go" \[e3\] \(disabled\)/);
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
