/**
 * Electron 启动入口（开发与生产共用）。
 *
 * 作用：
 * - 用安装好的 Electron 二进制打开仓库根目录（package.json 的 main 指向
 *   electron/main.cjs），把额外命令行参数透传给 Electron；
 * - 启动前剔除 ELECTRON_RUN_AS_NODE，保证拿到的是真正的桌面窗口；
 * - 把子进程的退出码 / 终止信号原样回传给当前 shell。
 *
 * 运行方式：
 *   pnpm start                                 直接启动
 *   pnpm dev                                   先起 Vite（127.0.0.1:5180），再经本脚本启动 Electron
 *   node scripts/launch.mjs --inspect=9229     手动附加 Electron 参数
 *
 * 依赖：electron（devDependency）、Node.js 内置的 node:child_process。
 */
import { spawn } from 'node:child_process';
import electron from 'electron';

// DSH 和部分终端会导出 ELECTRON_RUN_AS_NODE；桌面窗口不能继承它，
// 否则 Electron 会退化成普通 Node 解释器，不会创建 BrowserWindow。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// 参数 '.' 表示当前项目根目录（Electron 会读取其中的 package.json）。
// stdio: 'inherit' 让主进程日志直接输出到终端，便于排查启动问题。
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });

child.on('exit', (code, signal) => {
  // 被信号终止时（例如 Ctrl+C）用同样的信号结束自己，保持退出状态一致；
  // 否则透传子进程退出码，code 为空时按成功处理。
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
