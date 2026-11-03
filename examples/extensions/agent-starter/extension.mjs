import {
  defineExtension,
  defineTool,
} from '@earendil-works/pi-durable';

// 参数 schema 就是普通 JSON Schema，不需要 TypeBox 或任何 schema 库。
const echo = defineTool({
  name: 'extension_echo',
  description: 'Echo text through a Studio extension tool.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', maxLength: 4_000 },
    },
    required: ['text'],
  },
  replay: 'safe',
  async execute(args) {
    return {
      output: [{
        type: 'text',
        text: args.text,
      }],
    };
  },
});

export const durableExtension = defineExtension({
  name: 'studio-example-agent-starter',
  tools: [echo],
});

export const commands = {
  async welcome(context) {
    return {
      message: '扩展示例已加载，可以从右侧面板查看。',
      panelId: `${context.scope}:${context.manifestId}/overview`,
    };
  },
};
