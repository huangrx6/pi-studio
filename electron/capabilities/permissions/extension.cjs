const { requestPolicyConfirmation } = require('../../services/confirmations.cjs');
const {
  redactToolSecrets,
  resolveToolSecrets,
} = require('../../services/secret-vault.cjs');
const { createProtocol } = require('../subagents/index.cjs');
const {
  evaluateToolCall,
  rememberApproval,
} = require('./mode.cjs');

function stricterPermission(left, right) {
  const rank = { allow: 0, ask: 1, deny: 2 };
  return rank[right.decision] > rank[left.decision] ? right : left;
}

function createPermissionsExtension(durable) {
  const protocol = createProtocol(durable);
  return durable.defineExtension({
    name: 'studio-permissions',
    hooks: [
      durable.hook(durable.ToolTask, {
        async beforeTool(call, api, context) {
          const secrets = resolveToolSecrets(call.arguments || {});
          const evaluatedCall = secrets.expanded
            ? { ...call, arguments: secrets.arguments }
            : call;
          const sessionId = String(api.conversationId);
          const child = await api.snapshot(protocol.ChildContext, api.conversationId, context);
          const childEvaluation = await evaluateToolCall({
            sessionId,
            call: evaluatedCall,
            ...(child?.workspace ? { cwd: child.workspace } : {}),
          });
          // A child may run in a subdirectory while its parent policy is keyed
          // to the owning workspace. Evaluate both frames: omitting cwd resolves
          // the parent conversation workspace, while the explicit child cwd
          // catches boundaries introduced by a narrower child directory.
          const parentEvaluations = child?.parentConversationId
            ? await Promise.all([
              evaluateToolCall({
                sessionId: String(child.parentConversationId),
                call: evaluatedCall,
              }),
              evaluateToolCall({
                sessionId: String(child.parentConversationId),
                call: evaluatedCall,
                ...(child.workspace ? { cwd: child.workspace } : {}),
              }),
            ])
            : [];
          const parentEvaluation = parentEvaluations.length
            ? parentEvaluations.reduce(stricterPermission)
            : undefined;
          const evaluation = parentEvaluation
            ? stricterPermission(childEvaluation, parentEvaluation)
            : childEvaluation;
          if (evaluation.decision === 'allow') return;
          if (evaluation.decision === 'deny') {
            return {
              block: secrets.redact(
                `${evaluation.hardProtection?.title || '操作被权限策略拒绝'}：${evaluation.explanation}`,
              ),
            };
          }
          const response = await requestPolicyConfirmation(secrets.redact({
            sessionId,
            cwd: evaluation.cwd,
            tool: call.name,
            decision: evaluation.decision,
            explanation: evaluation.explanation,
            risk: evaluation.risk,
            rememberScopes: evaluation.rememberScopes,
            title: evaluation.risk?.title || '允许执行这个工具？',
            message: call.name === 'bash'
              ? `执行命令 · ${String(call.arguments?.command || '')}${secrets.expanded ? `\n\n使用凭据：${secrets.referenced.join('、')}` : ''}`
              : call.arguments?.path
                ? `${call.name} → ${String(call.arguments.path)}${secrets.expanded ? `\n\n使用凭据：${secrets.referenced.join('、')}` : ''}`
                : `${call.name}\n\n${JSON.stringify(call.arguments, null, 2).slice(0, 4_000)}${secrets.expanded ? `\n\n使用凭据：${secrets.referenced.join('、')}` : ''}`,
          }));
          if (!response.accepted) return { block: '用户拒绝了这次工具调用。' };
          if (response.remember) {
            try {
              rememberApproval({
                sessionId,
                cwd: evaluation.cwd,
                remember: response.remember,
                call,
                label: secrets.redact(`${call.name}：${evaluation.risk?.detail || '已批准'}`),
              });
            } catch (error) {
              // The tool was approved for this call. A failed convenience rule
              // must not turn the approved action into a denial.
              console.warn('Unable to remember tool approval:', error);
            }
          }
          // Durable checkpoints hook arguments. Expansion belongs exclusively
          // to the execution wrapper, after that checkpoint has been written.
        },
        async afterTool(_call, result) {
          return redactToolSecrets(result);
        },
      }),
    ],
  });
}

module.exports = {
  createPermissionsExtension,
  stricterPermission,
};
