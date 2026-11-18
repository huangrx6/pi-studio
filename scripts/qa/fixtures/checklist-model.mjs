// Control the next model response only after the desktop UI has shown the preceding tool result.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export async function startChecklistModel() {
  const pending = new Map();
  let sequence = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const prompt = body.messages.findLast(message => message.role === 'user');
    const tag = JSON.stringify(prompt?.content ?? '').match(/QA-(DONE|MISSED|STOP|FAIL|SWITCH|RESTART)/)?.[0];
    if (!tag || pending.has(tag)) {
      res.writeHead(400).end(JSON.stringify({ error: { message: 'Unexpected checklist model request' } }));
      return;
    }
    const request = { res, tools: body.tools || [] };
    pending.set(tag, request);
    res.on('close', () => { if (pending.get(tag) === request) pending.delete(tag); });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    async wait(tag) {
      const deadline = Date.now() + 15000;
      while (!pending.has(tag) && Date.now() < deadline) await delay(30);
      assert.ok(pending.has(tag), 'No model request for ' + tag);
    },
    async reply(tag, action) {
      await this.wait(tag);
      const { res, tools } = pending.get(tag);
      pending.delete(tag);
      if (action === 'fail') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'QA controlled model failure', type: 'invalid_request_error' } }));
        return;
      }
      const id = 'qa-' + ++sequence;
      const toolCall = typeof action === 'object';
      if (toolCall) assert.ok(tools.some(tool => tool.function?.name === 'todo'), 'todo tool is available');
      const delta = toolCall ? { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'todo', arguments: JSON.stringify(action) } }] } : { content: '已结束本次验收。' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'check',
        choices: [{ index: 0, delta, finish_reason }],
      }) + '\n\n');
      event({ role: 'assistant', ...delta });
      event({}, toolCall ? 'tool_calls' : 'stop');
      res.end('data: [DONE]\n\n');
    },
    async close() {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}
