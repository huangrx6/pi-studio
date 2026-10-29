import {
  defineExtension,
  defineTool,
  Type,
} from '@earendil-works/pi-durable';

const echo = defineTool({
  name: 'extension_echo',
  description: 'Echo text through a Studio extension tool.',
  parameters: Type.Object({
    text: Type.String({ maxLength: 4_000 }),
  }),
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
