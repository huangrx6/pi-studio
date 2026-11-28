// Bind a desktop failure to the Durable input that requested the operation.
// The next user submission (including a placed steer) gets its own decision.
const { checkChatTarget, confirmedDraftEdit, isEnter } = require('./chat-target.cjs');
const finalOnly = '本次电脑操控已停止。请向用户简要说明已完成的步骤、失败原因和需手动核实的结果。';
const terminalCodes = new Set([
  'desktop_type_failed', 'desktop_hotkey_failed', 'desktop_action_outcome_unknown',
  'desktop_keyboard_permission', 'desktop_accessibility_permission',
  'desktop_approval_denied', 'desktop_blocked', 'desktop_secure_target', 'desktop_disabled',
  'desktop_hotkey_blocked', 'desktop_unsupported_platform',
  'desktop_agent_focus_blocked', 'desktop_chat_target_mismatch', 'desktop_chat_draft_preserved',
]);
const chatTools = new Set(['desktop_act', 'desktop_click', 'desktop_type', 'desktop_hotkey']);

function isDesktopShellCommand(command) {
  const executable = /(?:^|[\n;|&(])\s*(?:\/usr\/bin\/)?(?:pbcopy|pbpaste|screencapture|cliclick|xdotool)(?=\s|$)|(?:^|[\n;|&(])\s*(?:\/usr\/bin\/)?open\s+[^\n;|&]*?(?:-[ab]\s|\.app\b)/i;
  return executable.test(command)
    || (/\bosascript\b/i.test(command) && /\b(?:activate|frontmost|keystroke|key code|System Events|clipboard)\b/i.test(command));
}

function createDesktopFailureHandling(durable) {
  const Stop = durable.defineDoc({
    kind: 'studio.desktop-input-stop', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
    initial: () => ({ submission: null }),
    checkpointWhen: () => true,
  });

  async function stopped(api, context) {
    const stop = await api.snapshot(Stop, api.conversationId, context);
    if (stop?.submission == null) return false;
    const live = await api.snapshot(durable.LiveDoc, api.conversationId, context);
    return live?.run?.inputs.at(-1) === stop.submission;
  }

  function wrap(tool) {
    return {
      ...tool,
      // A focus change, paste or submit must finish before a sibling call can proceed.
      ...(tool.replay === 'safe' ? {} : { executionMode: 'sequential' }),
      async execute(args, api, context) {
        let result;
        try {
          let prior;
          if (tool.name?.startsWith('desktop_')) {
            prior = await api.commit(async tx => {
              const live = await tx.doc(durable.LiveDoc, api.conversationId);
              const submission = live.run?.inputs.at(-1);
              if (submission == null) return null;
              const state = await tx.doc(Stop, api.conversationId);
              if (state.desktopSubmission !== submission) {
                state.desktopSubmission = submission;
                state.observedWindow = null;
                state.preparedChat = null;
              }
              const observed = { submission, observedWindow: state.observedWindow ?? null, preparedChat: state.preparedChat ?? null };
              const waitOnly = tool.name === 'desktop_act' && args.actions?.every(step => step.type === 'wait');
              if (tool.replay !== 'safe' && !waitOnly) {
                state.observedWindow = null;
                state.preparedChat = null;
              }
              return observed;
            }, context);
          }
          const prepared = chatTools.has(tool.name)
            ? await checkChatTarget(tool.name, args, api, durable, context, prior || {}) : null;
          result = await tool.execute(args, api, context);
          const fullWindow = result.details?.screenshot?.windowId
            ?? (tool.name === 'desktop_screenshot' ? result.details?.windowId : null);
          const frame = result.output?.some(block => block.type === 'image') ? fullWindow : null;
          if (prior && (frame != null || prepared) && !result.isError && result.details?.ok !== false) {
            await api.commit(async tx => {
              const state = await tx.doc(Stop, api.conversationId);
              if (state.desktopSubmission !== prior.submission) return;
              if (frame != null) state.observedWindow = frame;
              if (prepared && confirmedDraftEdit(tool.name, result.details)) state.preparedChat = prepared;
            }, context);
          }
        } catch (error) {
          const code = error?.cause?.code === 'desktop_action_outcome_unknown'
            ? error.cause.code : error?.code;
          if (typeof code !== 'string' || !code.startsWith('desktop_')) throw error;
          result = {
            isError: true,
            output: [{ type: 'text', text: error.message }],
            details: { ok: false, code },
          };
        }
        const details = result.details;
        const failed = details?.failedStep;
        if (!failed && !result.isError && !details?.screenshotError) return result;
        // A submission from an earlier successful step can have taken effect
        // even when a later step fails. Replaying the batch could send twice.
        const submitted = details?.steps?.some(step => step.ok && (step.submitted
          || (step.type === 'hotkey' && isEnter(step.chord))));
        const pressed = details?.steps?.some(step => step.ok && step.method === 'AXPress');
        const observationFailed = !failed && !result.isError && (submitted || pressed) && Boolean(details.screenshotError);
        if (!failed && !result.isError && !observationFailed) return result;
        const code = observationFailed
          ? (submitted ? 'desktop_submit_unverified' : 'desktop_press_unverified')
          : failed?.code || details?.code;
        const needsForeground = code === 'desktop_foreground_required' || code === 'desktop_mission_control_active';
        const pauseKey = needsForeground ? 'foregroundPause'
          : (['desktop_chat_target_required', 'desktop_chat_observation_required'].includes(code) ? 'chatTargetPause' : null);
        let retryable = !terminalCodes.has(code) && !submitted && !pressed;
        if (!retryable || pauseKey) {
          const stopNow = await api.commit(async tx => {
            const live = await tx.doc(durable.LiveDoc, api.conversationId);
            const submission = live.run?.inputs.at(-1);
            if (submission == null) return false;
            const state = await tx.doc(Stop, api.conversationId);
            if (retryable && pauseKey && state[pauseKey] !== submission) {
              state[pauseKey] = submission;
              return false; // Allow one correction using an observed target on the existing window.
            }
            state.submission = submission;
            return true;
          }, context);
          if (stopNow) retryable = false;
        }
        if (observationFailed) {
          const message = submitted ? '已按下提交键，截图失败。请在目标窗口核实提交结果。'
            : '已按下目标控件，截图失败。请在目标窗口核实操作结果。';
          return {
            ...result,
            output: [...result.output, { type: 'text', text: message }],
            details: { ...details, code, ...(submitted ? { submissionStatus: 'dispatched_unverified' } : { pressStatus: 'dispatched_unverified' }), retryable: false },
            diagnostics: [{ severity: 'warn', code, message }],
          };
        }
        const diagnostic = retryable
          ? (needsForeground ? '请保留原窗口编号，读取其辅助功能快照，用明确的控件引用继续。若缺少所需控件，请向用户说明待完成的步骤。' : '请查看失败步骤，保留已经执行的操作。')
          : '本次自动操作已停止。请核实输入和提交状态后再继续。';
        return {
          ...result,
          isError: true,
          details: { ...details, code, retryable },
          diagnostics: [{ severity: 'error', code, message: diagnostic }],
        };
      },
    };
  }

  return {
    wrap,
    hooks: [
      durable.hook(durable.ToolTask, {
        async beforeTool(call, api, context) {
          if (await stopped(api, context)) return { block: finalOnly };
          if (call.name === 'bash' && isDesktopShellCommand(String(call.arguments?.command || ''))) {
            const state = await api.snapshot(Stop, api.conversationId, context);
            if (state?.desktopSubmission == null) return;
            const live = await api.snapshot(durable.LiveDoc, api.conversationId, context);
            if (state.desktopSubmission === live?.run?.inputs.at(-1)) {
              return { block: '本轮电脑操控请通过桌面工具读取窗口和输入文字。若搜索结果仍不可见，请告知用户并停止。' };
            }
          }
        },
        async afterTool(_call, result, api, context) {
          const rejected = result.isError && result.diagnostics?.some(d =>
            ['blocked', 'invalid_arguments', 'tool_unavailable'].includes(d.code));
          if (rejected && await stopped(api, context)) {
            return { ...result, control: { ...result.control, terminate: true } };
          }
        },
      }),
      durable.hook(durable.GenerationTask, {
        async beforeRequest(request, api, context) {
          if (!await stopped(api, context)) return;
          // Remove declarations for this provider request only, including providers
          // which replay historical tool additions. Keep the committed context intact.
          const messages = request.messages.map(message => message.role === 'system'
            ? { ...message, toolsAdded: [], toolsRemoved: [] } : message);
          return { messages: [...messages, { role: 'system', content: finalOnly, timestamp: messages.at(-1)?.timestamp ?? 0 }] };
        },
      }),
    ],
  };
}

module.exports = { createDesktopFailureHandling };
