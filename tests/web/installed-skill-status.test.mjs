import assert from 'node:assert/strict';
import test from 'node:test';
import { installedSkillStatus } from '../../web/src/features/skills/installed-skill-status.ts';

const skill = (patch = {}) => ({ scope: 'project', available: false, trusted: false, trustChanged: false, disableModelInvocation: false, ...patch });

test('untrusted project skills require an explicit trust action', () => {
  assert.deepEqual(installedSkillStatus(skill()), { label: '等待信任', canTrust: true, trustLabel: '信任技能' });
});
test('directory changes invalidate prior trust rather than presenting a skill as auto-discoverable', () => {
  assert.deepEqual(installedSkillStatus(skill({ trustChanged: true })), { label: '内容已变化，需重新信任', canTrust: true, trustLabel: '重新信任' });
});
test('explicit invocation is an availability mode, not a reason to trust again', () => {
  assert.deepEqual(installedSkillStatus(skill({ available: true, trusted: true, disableModelInvocation: true })), { label: '仅显式调用', canTrust: false, trustLabel: '信任技能' });
});
test('available user and project skills are discoverable; user skills never offer project trust controls', () => {
  for (const scope of ['user', 'project']) {
    const status = installedSkillStatus(skill({ scope, available: true, trusted: true }));
    assert.equal(status.label, '自动发现');
    assert.equal(status.canTrust, false);
  }
  const unavailableUser = installedSkillStatus(skill({ scope: 'user' }));
  assert.equal(unavailableUser.canTrust, false);
  assert.equal(unavailableUser.label, '不可用');
});
