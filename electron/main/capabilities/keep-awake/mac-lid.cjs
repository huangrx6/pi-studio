const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

// Only system binaries and the bundled guard run with elevated privileges.
// Publish a complete root-owned plist before launchd can change any power setting.
const install = `set -eu
umask 077
plist="/Library/LaunchDaemons/$1.plist"
tmp=$(/usr/bin/mktemp /Library/LaunchDaemons/.pi-studio-lid.XXXXXX)
trap '/bin/rm -f "$tmp"' EXIT
/usr/bin/printf '%s' "$2" > "$tmp"
/usr/bin/plutil -lint "$tmp" >/dev/null
/bin/ln "$tmp" "$plist"
if ! /bin/launchctl bootstrap system "$plist"; then
  /bin/rm -f "$plist"
  exit 1
fi`;

const authorization = `on run argv
  set cmd to "/bin/sh -c " & quoted form of (item 1 of argv) & " guard " & quoted form of (item 2 of argv) & " " & quoted form of (item 3 of argv)
  do shell script cmd with administrator privileges with prompt "Pi Studio 请求在本次使用期间管理 MacBook 合盖休眠。"
end run`;

function guardPlist(label, id, secret, program) {
  const args = ['/usr/bin/perl', '-f', '-e', program, '--', id, String(process.pid), secret];
  const strings = args.map(arg => '<string>' + arg.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</string>');
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${strings.join('')}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>3</integer>
</dict></plist>`;
}

async function authorize({ id, secret, signal }) {
  const program = fs.readFileSync(path.join(__dirname, 'lid-guard.pl'), 'utf8');
  try {
    // A launchd job configured to retry must have a working system interpreter.
    await run('/usr/bin/perl', ['-f', '-c', '-e', program], { signal, timeout: 5000 });
  } catch { throw Object.assign(new Error('合盖运行组件不可用'), { code: 'GUARD_UNAVAILABLE' }); }
  const label = 'dev.pi.studio.lid-guard.' + id;
  await run('/usr/bin/osascript', ['-e', authorization, install, label, guardPlist(label, id, secret, program)], { signal });
}

const reasons = {
  low: '电量已降至 20% 或以下，已结束合盖运行。',
  battery: '无法确认电池电量，已结束合盖运行。',
  thermal: 'Mac 温度过高，已结束合盖运行。',
  busy: '另一份 Pi Studio 正在管理合盖休眠。',
  cancelled: '已取消管理员授权。',
  denied: '未能获得合盖运行授权，可重新开启。',
  unavailable: '当前系统无法启动合盖运行组件。',
  expired: '与 Studio 的连接已超时，已结束合盖运行。',
  failed: '合盖运行中断，请检查系统电源状态。',
  restoreFailed: '正在由系统重试恢复休眠。',
};

function startGuard(onState, requestAuthorization = authorize) {
  const id = crypto.randomBytes(16).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  const directory = '/private/tmp/pi-studio-lid-' + id;
  const controller = new AbortController();
  const peers = new Set();
  let directoryCreated = false;
  let socket;
  let stopped = false;
  let finished = false;
  let wanted = false;
  let stopReason = 'off';
  let heartbeat;
  let deadline;
  const server = net.createServer(peer => {
    peers.add(peer);
    peer.setEncoding('utf8');
    peer.setTimeout(24_000, () => peer.destroy());
    let buffer = '';
    peer.on('error', () => {});
    peer.on('close', () => {
      peers.delete(peer);
      if (peer === socket && !finished) finish('failed');
    });
    peer.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 512) return peer.destroy();
      let end;
      while (!finished && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (socket !== peer) {
          if (socket || line !== secret || stopped) return peer.destroy();
          socket = peer;
          expectReply();
          heartbeat = setInterval(send, 8000);
          heartbeat.unref();
          send();
        } else if (['armed', 'active', 'external'].includes(line)) {
          if (!stopped) { expectReply(); onState(line); }
        } else {
          finish(line === 'off' ? stopReason : Object.hasOwn(reasons, line) ? line : 'failed');
        }
      }
    });
  });
  function expectReply() {
    clearTimeout(deadline);
    deadline = setTimeout(() => finish('failed'), 24_000);
  }
  function send() { socket?.write(stopped ? 'STOP\n' : wanted ? 'HOLD\n' : 'IDLE\n'); }
  function finish(state) {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    clearTimeout(deadline);
    controller.abort();
    for (const peer of peers) peer.destroy();
    server.close();
    if (directoryCreated) fs.rmSync(directory, { recursive: true, force: true });
    onState(state);
  }
  server.on('error', () => finish('failed'));
  // The directory is private to this account, the peer checks Studio's kernel PID,
  // and the secret authenticates the privileged job's handshake back to Studio.
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    directoryCreated = true;
    server.listen(path.join(directory, 'control'), async () => {
      if (finished) return;
      try {
        await requestAuthorization({ id, secret, signal: controller.signal });
        if (!socket && !finished) deadline = setTimeout(() => finish('failed'), 15_000);
      } catch (error) {
        if (finished) return;
        if (error.code === 'GUARD_UNAVAILABLE') finish('unavailable');
        else finish(String(error.stderr).includes('(-128)') ? 'cancelled' : 'denied');
      }
    });
  } catch { queueMicrotask(() => finish('failed')); }
  return {
    setWanted(value) { if (wanted !== value && !stopped && !finished) { wanted = value; send(); } },
    stop(reason = 'off') {
      if (stopped || finished) return;
      stopped = true;
      stopReason = reason;
      if (!socket) return finish(reason);
      clearInterval(heartbeat);
      clearTimeout(deadline);
      send();
      deadline = setTimeout(() => finish('restoreFailed'), 24_000);
    },
  };
}

function createMacLidControl({ onChange, powerMonitor, open = startGuard, probe = async () =>
  /InternalBattery/.test((await run('/usr/bin/pmset', ['-g', 'batt'], { timeout: 2000 })).stdout) }) {
  let snapshot;
  let session;
  let closed = false;
  let wanted = false;
  function update(phase) {
    if (closed || snapshot?.phase === phase) return;
    snapshot = { phase, enabled: ['authorizing', 'armed', 'active', 'external'].includes(phase), message: reasons[phase] || '' };
    onChange();
  }
  void probe().then(available => { if (available) update('off'); }).catch(() => {});
  function stop(reason) {
    if (!session) return;
    update('stopping');
    session.stop(reason);
  }
  function thermal({ state }) {
    if (state === 'serious' || state === 'critical') stop('thermal');
  }
  powerMonitor?.on('thermal-state-change', thermal);
  return {
    get snapshot() { return snapshot; },
    setWanted(value) { wanted = value; session?.setWanted(value); },
    setEnabled(value) {
      if (!snapshot || closed) throw new Error('这台电脑不支持 MacBook 合盖运行');
      if (!value) return stop('off');
      if (session) return;
      if (['serious', 'critical'].includes(powerMonitor?.getCurrentThermalState?.())) return update('thermal');
      update('authorizing');
      session = open(phase => {
        if (phase === 'off' || Object.hasOwn(reasons, phase)) session = undefined;
        update(phase);
      });
      session.setWanted(wanted);
    },
    close() {
      closed = true;
      powerMonitor?.removeListener('thermal-state-change', thermal);
      session?.stop('off');
    },
  };
}

module.exports = { createMacLidControl, startGuard, guardPlist, authorization };
