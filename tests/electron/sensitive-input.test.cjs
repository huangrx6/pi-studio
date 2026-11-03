const assert = require('node:assert/strict');
const test = require('node:test');

const { scanSensitiveInput } = require('../../electron/core/sensitive-input.cjs');

test('high-confidence credentials yield stable fingerprints without the raw value', () => {
  const first = scanSensitiveInput([
    'Authorization: Bearer test-token-value-123456',
    'api_key=sk-live-1234567890abcdefghijkl',
    'OPENAI_KEY=sk-proj-abcdefghijklmnopqrstuvwx',
  ].join('\n'));
  const second = scanSensitiveInput('Authorization: Bearer test-token-value-123456');
  assert.equal(first.length, 3);
  assert.deepEqual(first[0], second[0]);
  assert.match(first[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(first), /test-token-value|sk-live|sk-proj/);
});

test('templates and ordinary prose do not prompt', () => {
  assert.deepEqual(scanSensitiveInput('Authorization: Bearer ${TOKEN}'), []);
  assert.deepEqual(scanSensitiveInput('api_key=<YOUR_KEY>'), []);
  assert.deepEqual(scanSensitiveInput('Explain how an API key is validated.'), []);
  assert.deepEqual(scanSensitiveInput('Use {{secret:TEST_TOKEN}} for the request.'), []);
});

test('private keys and URL passwords are recognized', () => {
  const findings = scanSensitiveInput([
    '-----BEGIN PRIVATE KEY-----',
    'https://user:correct-horse-battery@example.test/path',
  ].join('\n'));
  assert.deepEqual(findings.map(item => item.kind), ['private-key', 'url-password']);
});
