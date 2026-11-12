/**
 * OSC 133 命令标记的解析与导航。
 *
 * shell 通过转义序列告诉终端每条命令的边界：
 *   `133;A` 提示符出现（上一条命令输出结束）
 *   `133;B` 用户开始输入
 *   `133;C` 命令开始执行
 *   `133;D;<code>` 命令结束，带退出码
 *
 * 这里只做纯数据：把序列解析成事件，并维护一个可按方向跳转的命令位置表。
 * 真正画标记、滚动的部分留在组件里。
 */

/** 命令执行区间的一段：行号是 xterm 缓冲区坐标（0 起）。 */
export type CommandMark = {
  /** 命令所在行（提示符之后那一行）。 */
  row: number;
  /** 退出码；命令仍在执行时为 undefined。 */
  exitCode?: number;
  /** 是否从输出里看到过 D 标记。 */
  done: boolean;
};

export type Osc133Event =
  | { type: 'prompt'; }
  | { type: 'command-start' }
  | { type: 'command-end'; exitCode: number };

/**
 * 解析 OSC 133 的参数。
 *
 * 未知或残缺的参数返回 null —— shell 集成版本不一致时宁可少画一个标记，
 * 也不要把整行当成失败。
 */
export function parseOsc133(data: string): Osc133Event | null {
  const text = typeof data === 'string' ? data.trim() : '';
  if (!text) return null;
  const [kind, ...rest] = text.split(';');
  if (kind === 'A') return { type: 'prompt' };
  if (kind === 'C') return { type: 'command-start' };
  if (kind === 'D') {
    const raw = rest[0];
    if (raw === undefined || raw === '') return { type: 'command-end', exitCode: 0 };
    const code = Number(raw);
    return { type: 'command-end', exitCode: Number.isInteger(code) ? code : 0 };
  }
  return null;
}

/** 命令是否以失败结束；执行中与成功都算正常。 */
export function commandFailed(mark: CommandMark): boolean {
  return mark.done && typeof mark.exitCode === 'number' && mark.exitCode !== 0;
}

/**
 * 找出与当前位置相邻的那条命令。
 *
 * @param marks 按行号升序的命令表
 * @param currentRow 当前视口顶部所在行
 * @param direction -1 上一条，1 下一条
 * @returns 目标命令；已经没有更远的命令时返回 null
 */
export function adjacentCommand(
  marks: readonly CommandMark[],
  currentRow: number,
  direction: -1 | 1,
): CommandMark | null {
  if (marks.length === 0) return null;
  if (direction === -1) {
    for (let index = marks.length - 1; index >= 0; index -= 1) {
      if (marks[index].row < currentRow - 1) return marks[index];
    }
    return null;
  }
  for (const mark of marks) {
    if (mark.row > currentRow) return mark;
  }
  return null;
}

/** 最后一条失败的命令；没有失败时返回 null。 */
export function lastFailedCommand(marks: readonly CommandMark[]): CommandMark | null {
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    if (commandFailed(marks[index])) return marks[index];
  }
  return null;
}

/** 只保留最近这么多条命令，防止长时间使用后位置表无限增长。 */
const MAX_COMMANDS = 500;

/**
 * 命令位置表：按落点更新，供导航与失败计数使用。
 *
 * 一次性可变对象，因为每一步都跟着 PTY 输出走，用不可变更新没有收益。
 */
export class CommandTracker {
  private marks: CommandMark[] = [];
  private pendingRow: number | null = null;

  /** 命令开始执行：记住它落在哪一行。 */
  start(row: number): void {
    this.pendingRow = row;
  }

  /** 命令结束：补上退出码；没有 start 的 D（例如手动跑了别的脚本）忽略。 */
  end(exitCode: number): CommandMark | null {
    const row = this.pendingRow;
    this.pendingRow = null;
    if (row === null) return null;
    const mark: CommandMark = { row, exitCode, done: true };
    this.marks.push(mark);
    if (this.marks.length > MAX_COMMANDS) this.marks.splice(0, this.marks.length - MAX_COMMANDS);
    return mark;
  }

  /** 当前所有命令（按行号升序）。 */
  list(): readonly CommandMark[] {
    return this.marks;
  }

  /** 失败命令的数量，用于「跳到上一个失败」这类入口。 */
  failureCount(): number {
    return this.marks.filter(commandFailed).length;
  }

  reset(): void {
    this.marks = [];
    this.pendingRow = null;
  }
}
