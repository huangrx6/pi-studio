/** 模型上下文的 Token 单位；T 保留给超大规模模型与自定义来源。 */
export type TokenUnit = 'tokens' | 'k' | 'm' | 'b' | 't';
export type TokenField = 'contextWindow' | 'maxTokens';

const TOKEN_UNITS: ReadonlyArray<{ value: TokenUnit; label: string; scale: number }> = [
  { value: 'tokens', label: 'Tokens', scale: 1 },
  { value: 'k', label: 'K', scale: 1_000 },
  { value: 'm', label: 'M', scale: 1_000_000 },
  { value: 'b', label: 'B', scale: 1_000_000_000 },
  { value: 't', label: 'T', scale: 1_000_000_000_000 },
];

export const tokenUnitOptions: Array<{ value: TokenUnit; label: string }> =
  TOKEN_UNITS.map(({ value, label }) => ({ value, label }));

function tokenUnitScale(unit: TokenUnit): number {
  return TOKEN_UNITS.find((entry) => entry.value === unit)?.scale ?? 1;
}

/** 打开编辑器时选一个最易读的单位；界面显示会自动把 1000K 提升为 1M。 */
export function automaticTokenUnit(tokens?: number): TokenUnit {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return 'k';
  if (value >= 1_000_000_000_000) return 't';
  if (value >= 1_000_000_000) return 'b';
  if (value >= 1_000_000) return 'm';
  if (value >= 1_000) return 'k';
  return 'tokens';
}

function trimmedDecimal(value: number, digits = 6): string {
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

export function tokenInputValue(tokens: number | undefined, unit: TokenUnit): string {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return '';
  return trimmedDecimal(value / tokenUnitScale(unit));
}

export function tokenInputAsInteger(value: string, unit: TokenUnit): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  const tokens = Math.round(number * tokenUnitScale(unit));
  return tokens > 0 && tokens <= Number.MAX_SAFE_INTEGER ? tokens : undefined;
}

export function convertTokenInput(value: string, from: TokenUnit, to: TokenUnit): string {
  const tokens = tokenInputAsInteger(value, from);
  return tokens ? tokenInputValue(tokens, to) : value;
}

/** 卡片上使用紧凑但可读的标签；精确值仍由 title 与编辑框展示。 */
export function tokenLabel(tokens: number): string {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return '';
  const units = TOKEN_UNITS
    .filter((unit) => unit.scale > 1 && value >= unit.scale)
    .sort((a, b) => b.scale - a.scale);
  const unit = units[0];
  if (!unit) return Math.round(value).toLocaleString();
  const amount = value / unit.scale;
  const maximumFractionDigits = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits,
    useGrouping: false,
  }).format(amount)}${unit.label}`;
}

export function contextLabel(tokens: number): string {
  return tokenLabel(tokens);
}
