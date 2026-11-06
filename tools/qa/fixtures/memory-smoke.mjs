/** Deterministic renderer-only load. No preload, IPC, credentials, disk reads, or model requests. */
export function installMemorySmokeFixture() {
    const cwd = '/workspace/memory-regression';
    const model = {
      modelRef: 'qa/memory-fixture',
      label: 'Memory Fixture',
      thinkingLevel: 'high',
      thinkingLevels: ['off', 'high'],
      effectiveThinkingLevel: 'high',
      defaultThinkingLevel: 'high',
      supportsImages: true,
    };
    const definitions = [
      ['memory-long', 'Memory long transcript', 420],
      ['memory-medium-a', 'Memory medium A', 120],
      ['memory-medium-b', 'Memory medium B', 120],
    ];
    const summaries = new Map(definitions.map(([id, title, messageCount]) => [
      id,
      {
        id,
        cwd,
        title,
        messageCount,
        kind: 'conversation',
        goal: '',
        pinned: false,
        archived: false,
        createdAt: 1_793_923_200_000 - 60_000,
        updatedAt: 1_793_923_200_000 - definitions.findIndex(([value]) => value === id) * 1_000,
      },
    ]));
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">',
      '<rect width="640" height="400" fill="#17372f"/>',
      '<path d="M40 90h260M40 140h410M40 190h350" stroke="#b7e7d3" stroke-width="18" stroke-linecap="round"/>',
      '<circle cx="500" cy="105" r="52" fill="#64d7aa"/>',
      '<text x="40" y="330" fill="#f5fbf8" font-family="sans-serif" font-size="34">Memory fixture</text>',
      '</svg>',
    ].join('');
    const imageData = btoa(svg);
    const messagesBySession = new Map();

    function messagesFor(id) {
      if (messagesBySession.has(id)) return messagesBySession.get(id);
      const summary = summaries.get(id);
      const messages = [];
      for (let index = 0; index < summary.messageCount; index += 1) {
        if (index % 2 === 0) {
          messages.push({
            role: 'user',
            timestamp: 1_793_923_200_000 - summary.messageCount * 100 + index * 100,
            sourceIndex: index,
            content: [{
              type: 'text',
              text: `Memory question ${index / 2 + 1}: ${'请检查长会话的滚动、缓存与内存边界。'.repeat(5)}`,
            }],
          });
          continue;
        }
        const content = [
          {
            type: 'thinking',
            thinking: `第 ${Math.ceil(index / 2)} 轮先核对历史窗口与缓存边界。`,
          },
          {
            type: 'text',
            text: `## Memory response ${Math.ceil(index / 2)}\n\n${'这是用于验证长会话渲染、历史分页和缓存释放的确定性内容。'.repeat(28)}`,
          },
        ];
        if (index % 30 === 1) {
          content.push({
            type: 'toolCall',
            id: `read-${index}`,
            name: 'read',
            arguments: { path: `/workspace/memory-${index}.ts` },
          });
        }
        if (index % 60 === 29) {
          content.push(
            { type: 'image', mimeType: 'image/svg+xml', data: imageData },
            { type: 'image', mimeType: 'image/svg+xml', data: imageData },
          );
        }
        messages.push({
          role: 'assistant',
          timestamp: 1_793_923_200_000 - summary.messageCount * 100 + index * 100,
          sourceIndex: index,
          content,
        });
        if (index % 30 === 1) {
          messages.push({
            role: 'toolResult',
            timestamp: 1_793_923_200_000 - summary.messageCount * 100 + index * 100 + 1,
            sourceIndex: index,
            toolCallId: `read-${index}`,
            toolName: 'read',
            content: [{ type: 'text', text: 'Read completed.' }],
            details: { path: `/workspace/memory-${index}.ts` },
          });
        }
      }
      messagesBySession.set(id, messages);
      return messages;
    }

    let activeConversationId = definitions[0][0];
    const listeners = new Set();
    const subscriptions = new Set();
    const events = new Map();
    const calls = { subscribe: 0, unsubscribe: 0, pages: 0, children: 0, submits: 0 };
    let maxSubscriptions = 0;
    window.__memorySmoke = () => ({
      calls: { ...calls },
      listeners: { onConversationEvent: listeners.size, ...Object.fromEntries([...events].map(([key, values]) => [key, values.size])) },
      subscriptions: [...subscriptions], maxSubscriptions,
      fixtureMessages: Object.fromEntries([...messagesBySession].map(([key, messages]) => [key, messages.length])),
    });
    const childBase = {
      runId: 'memory-child-run',
      source: 'background',
      context: 'fork',
      model: model.modelRef,
      thinking: 'high',
      cwd,
      startedAt: 1_793_923_200_000 - 30_000,
      updatedAt: 1_793_923_200_000,
      tokens: 18_420,
      toolCount: 7,
      turnCount: 4,
      preview: '正在核对历史窗口、图片缓存与事件订阅的生命周期。',
      hasTranscript: true,
    };
    const children = Array.from({ length: 8 }, (_, index) => ({
      ...childBase,
      key: `child-${index}`,
      runId: `memory-child-run-${index}`,
      index,
      agent: `memory-agent-${index}`,
      name: `Memory child ${index + 1}`,
      task: `验证第 ${index + 1} 个子智能体的长上下文与缓存边界。`,
      status: index < 4 ? 'running' : 'completed',
      isolation: 'workspace',
      startedAt: 1_793_923_200_000 - (index + 1) * 20_000,
    }));
    const childMessages = Array.from({ length: 180 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      timestamp: 1_793_923_200_000 - 180_000 + index * 100,
      sourceIndex: index,
      content: [{
        type: 'text',
        text: index % 2
          ? `Child answer ${index}: ${'子智能体长上下文内容。'.repeat(18)}`
          : `Child question ${index}: ${'检查工具调用与结果边界。'.repeat(10)}`,
      }],
    }));

    function snapshot(id = activeConversationId) {
      return {
        ...summaries.get(id),
        running: false,
        requestId: '',
        compacting: false,
        inbox: [],
        tools: [],
        nestedTools: [],
        usage: {},
        model,
        agent: { cwd, name: 'Memory fixture agent' },
      };
    }

    function emit(event) {
      for (const listener of listeners) listener(event);
    }

    const api = {
      state: async () => ({
        workspaces: [{
          cwd,
          name: 'memory-regression',
          sessions: [...summaries.values()],
        }],
        cwd,
        model,
      }),
      models: async () => ({
        models: [{
          id: model.modelRef,
          name: model.label,
          provider: 'qa',
          providerName: 'QA',
          supportsImages: true,
        }],
        enabled: [model.modelRef],
        current: model.modelRef,
        selection: model,
        defaultSelection: model,
      }),
      conversationPage: async ({ id }) => {
        calls.pages++;
        activeConversationId = id;
        const messages = messagesFor(id);
        return {
          ...snapshot(id),
          messages,
          turnDiffs: [],
          page: { hasOlder: false },
          messageStart: 0,
          totalMessages: messages.length,
        };
      },
      conversationSnapshot: async (id) => snapshot(id),
      conversationOutline: async (id) => ({
        id,
        items: messagesFor(id)
          .filter((message) => message.role === 'user')
          .slice(-10)
          .map((message) => ({
            sourceIndex: message.sourceIndex,
            text: message.content[0].text.slice(0, 120),
            timestamp: message.timestamp,
          })),
        totalMessages: messagesFor(id).length,
      }),
      subscribeConversation: async (id) => {
        calls.subscribe++; subscriptions.add(id); maxSubscriptions = Math.max(maxSubscriptions, subscriptions.size);
        activeConversationId = id;
        return snapshot(id);
      },
      unsubscribeConversation: async (id) => { calls.unsubscribe++; subscriptions.delete(id); return { ok: true }; },
      onConversationEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      composerResources: async () => ({ commands: [], skills: [] }),
      sessionSubagents: async (id) => id === 'memory-long' ? children : children.slice(0, 2),
      subagentTranscript: async ({ childKey }) => { calls.children++; return ({
        child: children.find((child) => child.key === childKey),
        messages: childMessages,
        totalMessages: childMessages.length,
        hasMore: false,
        messageStart: 0,
      }); },
      extensionsUi: async () => ({
        items: [],
        errors: [],
        syncedAt: 1_793_923_200_000,
        apiVersion: 1,
      }),
      conversationExtensionUiPreferences: async () => ({
        version: 1,
        layout: 'grid',
        globalOrder: [],
        sessionOrders: {},
      }),
      saveConversationExtensionUiPreferences: async (value) => ({
        version: 1,
        layout: value?.layout || 'grid',
        globalOrder: value?.globalOrder || [],
        sessionOrders: value?.sessionOrders || {},
      }),
      conversationSubmit: async () => { calls.submits++; throw new Error('Memory QA never submits model requests'); },
    };
    window.piApi = new Proxy(api, {
      get(target, key) {
        if (key in target) return target[key];
        if (String(key).startsWith('on')) return (listener) => {
          const name = String(key); const values = events.get(name) || new Set(); events.set(name, values);
          values.add(listener); return () => values.delete(listener);
        };
        return async () => undefined;
      },
    });
}
