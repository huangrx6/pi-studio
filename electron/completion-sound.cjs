/**
 * Reliable completion sound for background agent work.
 *
 * macOS `shell.beep()` follows the alert-volume path and can be silent when alert
 * sounds are disabled. Playing a fixed system sound through afplay uses the normal
 * output volume while keeping every command and path immutable.
 */

const { spawn } = require('node:child_process');

const MACOS_AFPLAY = '/usr/bin/afplay';
const MACOS_COMPLETION_SOUND = '/System/Library/Sounds/Glass.aiff';

function playCompletionSound({
  platform = process.platform,
  spawnProcess = spawn,
  beep,
} = {}) {
  const useFallback = () => {
    if (typeof beep !== 'function') return false;
    try {
      beep();
      return true;
    } catch {
      return false;
    }
  };

  if (platform !== 'darwin') return useFallback();

  try {
    let fellBack = false;
    const child = spawnProcess(
      MACOS_AFPLAY,
      [MACOS_COMPLETION_SOUND],
      { stdio: 'ignore', windowsHide: true },
    );
    child.on?.('error', () => {
      if (fellBack) return;
      fellBack = true;
      useFallback();
    });
    child.unref?.();
    return true;
  } catch {
    return useFallback();
  }
}

module.exports = {
  MACOS_AFPLAY,
  MACOS_COMPLETION_SOUND,
  playCompletionSound,
};
