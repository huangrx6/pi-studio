/**
 * 模型与推理等级的类型定义，以及推理等级的展示文案。
 *
 * 数据来源是 electron 主进程的 `piApi.models(cwd)` / `setModel` /
 * `setThinkingLevel`。渲染进程只做展示与选择，真正的可用模型列表、
 * 启用列表和默认等级都由 Studio 读取自己的 SQLite 后计算。
 */

/** Pi 向模型暴露的具体推理等级；'default' 只属于选择器状态，不是模型能力。 */
export type ConcreteThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 推理等级。'default' 表示跟随 Pi 配置，不是具体等级。 */
export type ThinkingLevel = 'default' | ConcreteThinkingLevel;

/** 始终按强度从低到高展示，避免不同来源的顺序跳来跳去。 */
export const concreteThinkingLevels: readonly ConcreteThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** 当前模型选择快照，主进程返回后由 ModelPicker 和状态栏共同使用。 */
export type ModelSelection = {
  /** 模型唯一引用，形如 `provider/model`。 */
  modelRef: string;
  /** 展示名（按钮上显示）。 */
  label: string;
  /** 当前等级，可能是 'default'（尚未解析）。 */
  thinkingLevel: ThinkingLevel;
  /** 该模型可选的等级列表；长度大于 1 才认为支持推理设置。 */
  thinkingLevels: ThinkingLevel[];
  /** 解析 'default' 之后实际生效的等级。 */
  effectiveThinkingLevel: Exclude<ThinkingLevel, 'default'>;
  /** Studio 为新对话保存的默认等级，用于推理等级页脚说明。 */
  defaultThinkingLevel: Exclude<ThinkingLevel, 'default'>;
  /** 该快照属于新对话默认值，还是某条历史会话。 */
  source?: 'default' | 'session';
  /** 当前回合仍在运行：模型已选好，但会从下一轮开始生效。 */
  pending?: boolean;
  /** 会话 transcript 中记录的原模型已不在当前 Pi 模型目录中。 */
  unavailable?: boolean;
  /** 原模型不可用时的可读原因。 */
  unavailableReason?: string;
};

/** 模型目录中的一个模型。 */
export type ModelOption = {
  /** 唯一 id，形如 `provider/model`，与 modelRef 对应。 */
  id: string;
  /** 来源 id，用于分组和图标。 */
  provider: string;
  /** 来源展示名，作为分组标题。 */
  providerName: string;
  /** 模型在来源内的 id。 */
  model: string;
  /** 模型展示名。 */
  name: string;
  /** 上下文窗口大小（tokens）。 */
  contextWindow?: number;
  /** 最大输出 tokens。 */
  maxTokens?: number;
  /** 是否支持图片输入。 */
  supportsImages?: boolean;
  /** 是否为推理模型（决定能否调整推理等级）。 */
  reasoning?: boolean;
  /** 模型实际支持的 Pi 推理等级。 */
  thinkingLevels?: ConcreteThinkingLevel[];
};

/** `piApi.models()` 的返回值：完整目录 + 启用列表 + 当前选择。 */
export type ModelCatalog = {
  /** 主进程已知的全部模型。 */
  models: ModelOption[];
  /** 用户启用的模型 id；为空时表示不限制（显示全部）。 */
  enabled: string[];
  /** 当前模型的 id。 */
  current: string;
  /** 当前选择快照。 */
  selection: ModelSelection;
  /** 新对话默认值；与当前会话的 selection 并存。 */
  defaultSelection: ModelSelection;
};

/**
 * 推理等级的中英文展示文案。
 * 界面统一保留 Durable 的英文术语（Default / Off / …），避免与实际
 * thinking level 取值混淆。
 */
export const thinkingLabels: Record<ThinkingLevel, string> = {
  default: 'Default',
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};
