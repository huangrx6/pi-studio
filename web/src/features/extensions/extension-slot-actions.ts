import type {
  ExtensionCommandResult,
  ExtensionSettingsPage,
  ExtensionTone,
  ExtensionUiAction,
} from '../../types/extension-types';

export type ExtensionSlotOwner = Readonly<{
  key: string;
  generation: number;
}>;

export type ExtensionSlotActionEffects = {
  runCommand: (commandId: string) => Promise<ExtensionCommandResult>;
  openSettings: (page?: ExtensionSettingsPage) => void;
  openPanel: (panelId: string) => void;
  sendPrompt: (text: string, submit: boolean) => void;
  copyText: (text: string) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  notify: (message: string, tone?: ExtensionTone) => void;
};

const MAX_ACTION_CHAIN = 4;

export function extensionSlotOwnerKey(
  slot: string,
  cwd?: string,
  sessionId?: string,
  modelRef?: string,
): string {
  return JSON.stringify([slot, cwd ?? null, sessionId ?? null, modelRef ?? null]);
}

export function advanceExtensionSlotOwner(
  previous: ExtensionSlotOwner,
  key: string,
): ExtensionSlotOwner {
  if (previous.key === key) return previous;
  return { key, generation: previous.generation + 1 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function applyExtensionSlotAction(
  action: ExtensionUiAction,
  isCurrentOwner: () => boolean,
  effects: ExtensionSlotActionEffects,
  actionDepth: number,
): Promise<void> {
  if (!isCurrentOwner()) return;
  if (action.kind === 'openSettings') {
    effects.openSettings(action.panel);
    return;
  }
  if (action.kind === 'openPanel') {
    effects.openPanel(action.panelId);
    return;
  }
  if (action.kind === 'sendPrompt') {
    effects.sendPrompt(action.text, Boolean(action.submit));
    return;
  }
  if (action.kind === 'copyText') {
    await effects.copyText(action.text);
    if (isCurrentOwner()) effects.notify('已复制到剪贴板。', 'success');
    return;
  }
  if (action.kind === 'openUrl') {
    await effects.openUrl(action.url);
    return;
  }
  if (action.kind === 'runCommand') {
    await executeExtensionSlotCommand(action.commandId, isCurrentOwner, effects, actionDepth + 1);
    return;
  }
  throw new Error('扩展返回了不受支持的操作');
}

export async function executeExtensionSlotCommand(
  commandId: string,
  isCurrentOwner: () => boolean,
  effects: ExtensionSlotActionEffects,
  actionDepth = 0,
): Promise<boolean> {
  if (!isCurrentOwner()) return false;
  if (actionDepth > MAX_ACTION_CHAIN) {
    throw new Error('扩展操作链过深，已停止继续执行');
  }
  const result = await effects.runCommand(commandId);
  if (!isCurrentOwner()) return false;

  if (result.action) {
    await applyExtensionSlotAction(result.action, isCurrentOwner, effects, actionDepth);
    if (!isCurrentOwner()) return false;
  }
  if (result.promptText) {
    if (!isCurrentOwner()) return false;
    effects.sendPrompt(result.promptText, Boolean(result.submit));
  }
  if (result.settingsPage) {
    if (!isCurrentOwner()) return false;
    effects.openSettings(result.settingsPage);
  }
  if (result.panelId) {
    if (!isCurrentOwner()) return false;
    effects.openPanel(result.panelId);
  }
  if (result.message) {
    if (!isCurrentOwner()) return false;
    effects.notify(result.message);
  }
  return isCurrentOwner();
}

export async function activateExtensionSlotAction(
  action: ExtensionUiAction,
  isCurrentOwner: () => boolean,
  effects: ExtensionSlotActionEffects,
): Promise<boolean> {
  try {
    await applyExtensionSlotAction(action, isCurrentOwner, effects, 0);
    return isCurrentOwner();
  } catch (error) {
    if (isCurrentOwner()) effects.notify(errorMessage(error), 'error');
    return false;
  }
}
