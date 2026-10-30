const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_TRACE_CHARS,
  boundMessages,
  normalizeRequestMessages,
  sanitizeValue,
} = require('../../electron/services/studio-request-trace.cjs');
const {
  createStudioDatabase,
} = require('../../electron/core/studio-db.cjs');

test('request snapshots expand Durable system sections, omit image bytes, and redact credentials', () => {
  const messages = normalizeRequestMessages([
    {
      role: 'system',
      content: '',
      sections: {
        harness: '<harness>exact system prompt</harness>',
        skills: '<skills>available skill</skills>',
      },
      timestamp: 1,
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Authorization: Bearer secret-token-value-123' },
        { type: 'image', mimeType: 'image/png', data: Buffer.alloc(48).toString('base64') },
      ],
      timestamp: 2,
    },
  ]);

  assert.match(messages[0].content.map((block) => block.text || '').join('\n'), /exact system prompt/);
  assert.match(messages[0].content.map((block) => block.text || '').join('\n'), /available skill/);
  assert.equal(messages[1].content[0].text.includes('secret-token-value-123'), false);
  assert.deepEqual(messages[1].content[1], {
    type: 'image',
    mimeType: 'image/png',
    bytes: 48,
    omitted: true,
  });
  assert.deepEqual(sanitizeValue({
    apiKey: 'plain-secret',
    nested: { refresh_token: 'refresh-secret', safe: 'visible' },
  }), {
    apiKey: '[REDACTED]',
    nested: { refresh_token: '[REDACTED]', safe: 'visible' },
  });
});

test('oversized request snapshots keep system instructions and the newest user message', () => {
  const messages = normalizeRequestMessages([
    { role: 'system', content: `SYSTEM_START\n${'s'.repeat(380_000)}\nSYSTEM_END` },
    ...Array.from({ length: 30 }, (_, index) => ({
      role: 'user',
      content: `older-${index}\n${'x'.repeat(12_000)}`,
    })),
    { role: 'user', content: 'NEWEST_USER_MARKER' },
  ]);
  const bounded = boundMessages(messages);

  assert.equal(bounded.truncated, true);
  assert.equal(bounded.messages[0].role, 'trace');
  assert.match(bounded.messages[0].content[0].text, /条上下文消息/);
  assert.match(
    bounded.messages.filter((message) => message.role === 'system')
      .flatMap((message) => message.content)
      .map((block) => block.text || '')
      .join('\n'),
    /SYSTEM_START/,
  );
  assert.match(
    bounded.messages.at(-1).content.map((block) => block.text || '').join('\n'),
    /NEWEST_USER_MARKER/,
  );
  assert.ok(JSON.stringify(bounded.messages).length <= MAX_TRACE_CHARS);
});

test('request traces are pruned and removed with their Studio conversation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-request-db-'));
  const database = createStudioDatabase(path.join(directory, 'studio.sqlite'));
  try {
    const conversation = database.insertConversation({
      id: '9101',
      publicId: 'request-trace-public',
      workspace: directory,
      kind: 'conversation',
      title: 'Request traces',
    });
    for (let index = 1; index <= 50; index += 1) {
      database.saveRequestTrace(conversation.publicId, {
        id: `trace-${index}`,
        requestId: `request-${index}`,
        createdAt: index,
        messages: [],
      });
    }

    const traces = database.listRequestTraces(conversation.publicId);
    assert.equal(traces.length, 48);
    assert.equal(traces[0].requestId, 'request-3');
    assert.equal(traces.at(-1).requestId, 'request-50');

    database.deleteConversation(conversation.id);
    assert.deepEqual(database.listRequestTraces(conversation.publicId), []);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
