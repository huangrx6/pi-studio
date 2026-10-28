/**
 * Pi UI 契约示例扩展。
 *
 * 只用 Pi 标准的 ctx.ui 原语，不 import 任何 Pi Studio 代码；
 * 在 `pi` 终端和 Pi Studio 中运行的是同一份实现：
 *   - setStatus   → 桌面状态条
 *   - setWidget   → 输入框上/下方的通用 widget
 *   - custom      → 桌面通用浮层（pi-tui Component）
 *   - select/input→ 桌面统一对话框
 *
 * 安装：把本目录复制/软链到 ~/.pi/agent/extensions/ 下，重启 pi 或 Pi Studio。
 */
export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.setStatus('ui-contract', '示例扩展已加载');
    ctx.ui.setWidget('ui-contract:above', ['Pi UI 契约示例 · aboveEditor'], { placement: 'aboveEditor' });
    ctx.ui.setWidget('ui-contract:below', (tui, theme) => ({
      render: (width) => [
        theme.fg('accent', '组件型 widget'),
        theme.fg('muted', `当前宽度 ${width} 列`),
      ],
      invalidate: () => {},
    }), { placement: 'belowEditor' });
  });

  pi.registerCommand('ui-contract', {
    description: '演示 Pi 标准 UI 原语',
    handler: async (_args, ctx) => {
      await ctx.ui.custom((tui, theme, keybindings, done) => ({
        render: () => [
          '╭────────────────────────╮',
          '│  custom() 通用浮层     │',
          '│  Enter 完成 · Esc 关闭 │',
          '╰────────────────────────╯',
        ],
        handleInput: (data) => { if (data === '\r') done('ok'); },
        invalidate: () => {},
      }), { overlay: true });

      const choice = await ctx.ui.select('选择一个选项', ['选项 A — 说明 A', '选项 B — 说明 B']);
      const text = await ctx.ui.input('输入一些文字', '随便写点什么');
      ctx.ui.notify(`选择：${choice || '（取消）'} · 输入：${text || '（空）'}`, 'info');
    },
  });
}
