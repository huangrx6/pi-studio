#!/usr/bin/env node
/**
 * Minimal stdio MCP server for the toolkit-starter example.
 * Implements initialize + tools/list + tools/call for one echo tool.
 */
import { createInterface } from 'node:readline';

const tools = [
  {
    name: 'toolkit_echo',
    description: 'Echo text from the toolkit-starter example plugin.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
    },
  },
];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;
  if (method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'toolkit-demo', version: '0.1.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id, result: { tools } });
    return;
  }
  if (method === 'tools/call') {
    const text = String(params?.arguments?.text ?? '');
    write({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: text || '(empty)' }],
        isError: false,
      },
    });
    return;
  }
  if (id !== undefined) {
    write({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handle(JSON.parse(trimmed));
  } catch (error) {
    write({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: error?.message || 'parse error' },
    });
  }
});
