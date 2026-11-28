use strict;
use warnings;
use Fcntl qw(:DEFAULT :flock);
use File::Basename qw(dirname);
use IO::Handle;
use IO::Select;
use IO::Socket::UNIX;
use Socket qw(SOCK_STREAM);

# The launchd job accepts just HOLD, IDLE and STOP from the authorizing Studio
# process. Its restart path repairs the persistent pmset flag after a crash or reboot.
my $owner = '/private/var/db/dev.pi.studio.lid-guard.owner';

sub power_read {
    my (@args) = @_;
    open my $reader, '-|', '/usr/bin/pmset', @args or die "power read";
    my $text = do { local $/; <$reader> };
    close $reader or die "power read";
    return $text // '';
}

sub sleep_disabled {
    my $text = power_read('-g');
    die "unknown power settings" unless $text =~ /System-wide power settings:/;
    return $1 if $text =~ /^\s*SleepDisabled\s+([01])\s*$/m;
    die "unknown SleepDisabled value" if $text =~ /^\s*SleepDisabled\b/m;
    return 0;  # An unset key uses normal macOS sleep.
}

sub battery_guard {
    my ($text) = @_;
    return 'battery' unless $text =~ /InternalBattery[^\n]*?\b(\d{1,3})%/;
    my $percent = $1;
    return 'battery' if $percent > 100;
    return '' if $text =~ /Now drawing from 'AC Power'/;
    return 'battery' unless $text =~ /Now drawing from 'Battery Power'/;
    return $percent <= 20 ? 'low' : '';
}

sub write_sleep {
    my ($value) = @_;
    system('/usr/bin/pmset', '-a', 'disablesleep', $value) == 0 or die "power write";
    die "power verification" unless sleep_disabled() == $value;
}

sub sync_entry {
    my ($path) = @_;
    sysopen my $entry, $path, O_RDONLY or die "open recovery record";
    $entry->sync or die "sync recovery record";
}

sub restore_sleep {
    my ($journal, $read, $write) = @_;
    return unless -e $journal;
    $write->(0) if $read->();
    unlink $journal or die "clear ownership";
    sync_entry(dirname($journal));
}

sub hold_sleep {
    my ($journal, $read, $write) = @_;
    if ($read->()) { return -e $journal ? 'active' : 'external'; }
    # Respect a manual change made after Studio acquired the setting.
    die "power policy changed" if -e $journal;
    sysopen my $file, $journal, O_CREAT | O_EXCL | O_WRONLY, 0600 or die "record ownership";
    $file->sync or die "sync ownership";
    close $file or die "close ownership";
    sync_entry(dirname($journal));
    $write->(1);
    return 'active';
}

sub serve {
    my ($socket, $battery, $hold, $restore, $lease) = @_;
    my $select = IO::Select->new($socket);
    my $pending = '';
    while ($select->can_read($lease)) {
        my $length = sysread($socket, my $chunk, 128);
        return 'off' unless $length;
        $pending .= $chunk;
        while ($pending =~ s/^([^\n]*)\n//) {
            my $command = $1;
            return 'off' if $command eq 'STOP';
            my $state;
            if ($command eq 'HOLD') {
                my $reason = $battery->();
                return $reason if $reason;
                $state = $hold->();
            } elsif ($command eq 'IDLE') {
                $restore->();
                $state = 'armed';
            } else { return 'failed'; }
            print {$socket} "$state\n" or return 'off';
        }
        return 'failed' if length($pending) > 8;
    }
    return 'expired';
}

sub connect_studio {
    my ($id, $pid, $secret) = @_;
    my $socket = IO::Socket::UNIX->new(Type => SOCK_STREAM, Peer => "/private/tmp/pi-studio-lid-$id/control");
    return unless $socket;
    # Darwin SOL_LOCAL / LOCAL_PEERPID identifies the process listening on this socket.
    my $peer = getsockopt($socket, 0, 2);
    return unless defined($peer) && unpack('i', $peer) == $pid;
    $socket->autoflush(1);
    print {$socket} "$secret\n" or return;
    return $socket;
}

sub guard_session {
    my ($socket, $battery, $hold, $restore, $lease) = @_;
    # Holding the machine-wide lock means any pre-existing journal is orphaned.
    $restore->();
    return 'off' unless $socket;
    my $result = eval {
        local $SIG{TERM} = sub { die "terminated" };
        serve($socket, $battery, $hold, $restore, $lease);
    } // 'failed';
    $restore->();
    return $result;
}

sub run_guard {
    my ($id, $pid, $secret) = @_;
    die "invalid session" unless $> == 0 && $id =~ /\A[a-f0-9]{32}\z/ && $pid =~ /\A[1-9]\d*\z/ && $secret =~ /\A[a-f0-9]{64}\z/;
    umask 0077;
    $ENV{LC_ALL} = 'C';
    $SIG{PIPE} = 'IGNORE';
    my $label = "dev.pi.studio.lid-guard.$id";
    my $plist = "/Library/LaunchDaemons/$label.plist";
    my $socket = connect_studio($id, $pid, $secret);
    sysopen my $lock, '/private/var/run/dev.pi.studio.lid-guard.lock', O_CREAT | O_RDWR, 0600 or die "lock file";
    if (flock($lock, LOCK_EX | LOCK_NB)) {
        my $restore = sub { restore_sleep($owner, \&sleep_disabled, \&write_sleep); };
        my $boot_entry_synced = 0;
        my $hold = sub {
            # The boot job and journal must reach disk before the persistent power change.
            unless ($boot_entry_synced) {
                sync_entry($plist);
                sync_entry(dirname($plist));
                $boot_entry_synced = 1;
            }
            return hold_sleep($owner, \&sleep_disabled, \&write_sleep);
        };
        my $result = eval { guard_session($socket, sub { battery_guard(power_read('-g', 'batt')) }, $hold, $restore, 24) };
        unless (defined $result) {
            print {$socket} "restoreFailed\n" if $socket;
            die "restore pending";  # Keep the plist and journal so launchd retries.
        }
        print {$socket} "$result\n" if $socket;
    } elsif ($socket) { print {$socket} "busy\n"; }
    close $socket if $socket;
    # The current job is one session only. On a clean exit it removes its boot entry.
    unlink $plist or die "remove boot entry" if -e $plist;
    exec '/bin/launchctl', 'bootout', "system/$label";
    die "unload job";
}

run_guard(@ARGV) unless caller;
1;
