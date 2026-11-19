import assert from 'node:assert/strict';
import test from 'node:test';

const { resolveComposerPrimaryAction } = await import('../../web/src/features/conversation/composer-primary-action.ts');

test('composer primary action morphs by run and draft state', () => {
  assert.equal(resolveComposerPrimaryAction({ running: false, stopping: false, hasContent: false }), 'send');
  assert.equal(resolveComposerPrimaryAction({ running: false, stopping: false, hasContent: true }), 'send');
  assert.equal(resolveComposerPrimaryAction({ running: true, stopping: false, hasContent: false }), 'stop');
  assert.equal(resolveComposerPrimaryAction({ running: true, stopping: false, hasContent: true }), 'queue');
  assert.equal(resolveComposerPrimaryAction({ running: true, stopping: true, hasContent: true }), 'stopping');
  assert.equal(resolveComposerPrimaryAction({ running: false, stopping: false, preparing: true, hasContent: true }), 'preparing');
  // Stopping wins over preparing/running so the button cannot flip mid-stop.
  assert.equal(resolveComposerPrimaryAction({ running: true, stopping: true, preparing: true, hasContent: false }), 'stopping');
});
