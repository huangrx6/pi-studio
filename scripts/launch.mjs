import { spawn } from 'node:child_process';
import electron from 'electron';

// DSH and some terminals export ELECTRON_RUN_AS_NODE; a desktop window must not
// inherit it, otherwise Electron behaves as plain Node.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
