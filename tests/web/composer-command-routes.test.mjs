import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeThinkingLevelArgument,
  parseGoalCommandArgument,
  parseStudioCommand,
} from '../../web/src/lib/composer-command-routes.mjs';

test('thinking opens the current-session picker and accepts an optional level', () => {
  assert.deepEqual(parseStudioCommand('/thinking'), {
    name: 'thinking',
    route: 'thinking.picker',
    argument: '',
    raw: '/thinking',
  });
  assert.equal(parseStudioCommand('/thinking X-High')?.argument, 'X-High');
  assert.equal(normalizeThinkingLevelArgument('X-High'), 'xhigh');
  assert.equal(normalizeThinkingLevelArgument(' default '), 'default');
  assert.equal(normalizeThinkingLevelArgument('turbo'), null);
});

test('Studio-native command matching is exact and case-insensitive', () => {
  assert.equal(parseStudioCommand('/MODEL')?.route, 'model.picker');
  assert.equal(parseStudioCommand('/GOAL finish the migration')?.route, 'goal.control');
  assert.equal(parseStudioCommand('/thoughts'), null);
  assert.equal(parseStudioCommand('/thinking-extra high'), null);
  assert.equal(parseStudioCommand('text /thinking'), null);
});

test('goal commands cover the full persistent-goal lifecycle', () => {
  assert.deepEqual(parseGoalCommandArgument(''), { action: 'view', text: '' });
  assert.deepEqual(
    parseGoalCommandArgument('Finish the migration'),
    { action: 'set', text: 'Finish the migration' },
  );
  assert.deepEqual(
    parseGoalCommandArgument('edit Keep tests green'),
    { action: 'edit', text: 'Keep tests green' },
  );
  assert.deepEqual(
    parseGoalCommandArgument('complete Verified locally'),
    { action: 'complete', text: 'Verified locally' },
  );
  assert.deepEqual(parseGoalCommandArgument('pause'), { action: 'pause', text: '' });
  assert.deepEqual(parseGoalCommandArgument('resume'), { action: 'resume', text: '' });
  assert.deepEqual(parseGoalCommandArgument('clear'), { action: 'clear', text: '' });
});

test('extension, prompt and skill commands remain pass-through', () => {
  assert.equal(parseStudioCommand('/pi-subagents run reviewer'), null);
  assert.equal(parseStudioCommand('/review this diff'), null);
  assert.equal(parseStudioCommand('/skill:frontend-design make it calm'), null);
});
