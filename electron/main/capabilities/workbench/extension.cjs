/** Host view refresh tool for agent workflows that mutate files or databases directly. */

const toolSchema = require('../../runtime/tool-schema.cjs');
const { WORKBENCH_REFRESH_SCOPES, refreshWorkbenchViews } = require('../../services/workbench-refresh.cjs');

function createWorkbenchTools(durable) {
  const { defineExtension, defineTool } = durable;
  const Type = toolSchema;

  const refreshTool = defineTool({
    name: 'workbench_refresh',
    description: 'Refresh currently open Pi Studio views (active plugin data/panel views, workspace file tree, file preview, Git changes, or conversation list) after writing files or modifying plugin databases directly.',
    replay: 'safe',
    parameters: Type.Object({
      scope: Type.Optional(Type.String({
        enum: [...WORKBENCH_REFRESH_SCOPES],
        description: 'Target UI scope to refresh: all (default), extensions, files, git, or sessions.',
      })),
      extensionId: Type.Optional(Type.String({
        maxLength: 120,
        description: 'Optional extension ID (e.g. studio.task-board) when refreshing extension views.',
      })),
      sourceId: Type.Optional(Type.String({
        maxLength: 160,
        description: 'Optional extension data source ID when refreshing a specific view.',
      })),
    }, { additionalProperties: false }),
    async execute(args = {}) {
      const result = await refreshWorkbenchViews(args || {});
      return {
        output: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  return defineExtension({
    name: 'studio-workbench-tools',
    tools: [refreshTool],
  });
}

module.exports = { createWorkbenchTools };
