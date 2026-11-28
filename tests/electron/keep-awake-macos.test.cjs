const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const test = require('node:test');
const { guardPlist, startGuard } = require('../../electron/main/capabilities/keep-awake/mac-lid.cjs');

const mac = { skip: process.platform !== 'darwin', timeout: 8000 };
const worker = path.resolve(__dirname, '../../electron/main/capabilities/keep-awake/lid-guard.pl');
const run = promisify(execFile);

test('the launchd recovery job survives crashes and its embedded worker compiles', mac, () => {
  const label = 'dev.pi.studio.lid-guard.test';
  const plist = guardPlist(label, 'a'.repeat(32), 'b'.repeat(64), readFileSync(worker, 'utf8'));
  const job = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: plist }));
  assert.equal(job.Label, label);
  assert.equal(job.RunAtLoad, true);
  assert.deepEqual(job.KeepAlive, { SuccessfulExit: false });
  const [perl, ignoreSiteConfig, flag, code] = job.ProgramArguments;
  assert.deepEqual([perl, ignoreSiteConfig, flag], ['/usr/bin/perl', '-f', '-e']);
  execFileSync(perl, ['-f', '-c', '-e', code], { stdio: 'pipe' });
});

test('the native guard preserves pre-existing settings and retries an interrupted restore', mac, t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'studio-lid-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('/usr/bin/perl', ['-e', `
    use strict;
    use warnings;
    do shift(@ARGV) or die $@ || $!;
    my $file = shift;
    my $power = 1;
    my @writes;
    my $read = sub { $power };
    my $write = sub { push @writes, $_[0]; $power = $_[0]; };
    die 'external' unless hold_sleep($file, $read, $write) eq 'external' && !-e $file;
    restore_sleep($file, $read, $write);
    die 'changed original' unless $power && !@writes;
    $power = 0;
    die 'hold' unless hold_sleep($file, $read, $write) eq 'active' && -e $file && $power;
    hold_sleep($file, $read, $write);
    eval { restore_sleep($file, $read, sub { die 'transient pmset failure' }); };
    die 'lost journal' unless -e $file;
    restore_sleep($file, $read, $write);
    die 'recovery' unless !$power && !-e $file && "@writes" eq '1 0';
    my $sample = sub { "Now drawing from '$_[0] Power'\\n -InternalBattery-0 (id=14) $_[1]%; discharging;" };
    die 'low' unless battery_guard($sample->('Battery', 20)) eq 'low';
    die 'safe battery' if battery_guard($sample->('Battery', 21));
    die 'AC' if battery_guard($sample->('AC', 12));
    die 'unknown' unless battery_guard("Now drawing from 'Battery Power'") eq 'battery';
  `, worker, path.join(directory, 'owner')]);
});

test('Studio and the native guard authenticate over a real socket and release on low battery', mac, async t => {
  // Exercise the shipped Perl protocol without granting privileges or touching pmset.
  let guardRun;
  const done = Promise.withResolvers(), states = [];
  const session = startGuard(state => {
    states.push(state);
    if (state === 'active') session.setWanted(false);
    else if (state === 'armed') session.setWanted(true);
    else if (state === 'low') done.resolve();
    else done.reject(new Error(state));
  }, async ({ id, secret }) => {
    guardRun = run('/usr/bin/perl', ['-e', `
      do shift(@ARGV) or die $@ || $!;
      my $sock = connect_studio(@ARGV) or die 'peer PID';
      my ($samples, $held) = (0, 0);
      my $result = guard_session($sock, sub { ++$samples > 1 ? 'low' : '' },
        sub { $held = 1; 'active' }, sub { $held = 0 }, 2);
      die 'idle did not release' if $held;
      print {$sock} "$result\\n";
    `, worker, id, String(process.pid), secret]);
    guardRun.catch(() => {});
  });
  t.after(() => session.stop());
  session.setWanted(true);
  await done.promise;
  await guardRun;
  assert.deepEqual(states, ['active', 'armed', 'low']);
});

test('a sleeping or terminated Studio process releases an active native policy and a restart repairs its journal', mac, () => {
  execFileSync('/usr/bin/perl', ['-e', `
    use Socket qw(AF_UNIX SOCK_STREAM);
    use IO::Handle;
    do shift(@ARGV) or die $@ || $!;
    for my $end ('off', 'expired', 'low') {
      socketpair(my $app, my $guard, AF_UNIX, SOCK_STREAM, 0) or die $!;
      $app->autoflush(1); $guard->autoflush(1);
      print {$app} "HOLD\\n";
      if ($end eq 'off') { shutdown($app, 1); }
      if ($end eq 'low') { print {$app} "HOLD\\n"; }
      my ($held, $reads, @history) = (0, 0);
      my $result = guard_session($guard, sub { ++$reads > 1 ? 'low' : '' },
          sub { $held = 1; push @history, 1; 'active' },
          sub { push @history, 0 if $held; $held = 0; }, 0.05);
      die "failed $end" unless $result eq $end && !$held && "@history" eq '1 0';
    }
    my $orphaned = 1;
    guard_session(undef, sub { die }, sub { die }, sub { $orphaned = 0 }, 1);
    die 'orphaned setting' if $orphaned;
  `, worker]);
});

test('authorization cancellation and a late approval cannot arm the guard', mac, async () => {
  const cancelled = Promise.withResolvers();
  startGuard(cancelled.resolve, async () => { throw Object.assign(new Error(), { stderr: 'User canceled. (-128)' }); });
  assert.equal(await cancelled.promise, 'cancelled');
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  const states = [];
  const session = startGuard(state => states.push(state), ({ signal }) => { started.resolve(signal); return pending.promise; });
  const signal = await started.promise;
  session.stop();
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.deepEqual(states, ['off']);
});
