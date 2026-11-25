import { useEffect, useState } from 'react';

export function useLaunchScreen(viewReady: boolean, wallpaperUrl: string | undefined, showInside: boolean) {
  const [outerReady, setOuterReady] = useState('');
  const [innerSettled, setInnerSettled] = useState('');
  const wallpaperReady = !wallpaperUrl || (outerReady === wallpaperUrl && (!showInside || innerSettled === wallpaperUrl));

  useEffect(() => {
    const screen = document.getElementById('launch-screen');
    if (!screen || screen.dataset.leaving || !viewReady) return;

    function reveal() {
      if (!screen || screen.dataset.leaving) return;
      screen.dataset.leaving = 'true';
      const finish = () => {
        screen.remove();
        document.getElementById('root')!.inert = false;
        window.piApi.workspaceReady?.();
      };
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        finish();
      } else {
        screen.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 180,
          easing: 'cubic-bezier(.22, 1, .36, 1)',
          fill: 'forwards',
        }).finished.then(finish, finish);
      }
    }

    if (wallpaperReady) { reveal(); return; }
    // The wallpaper layers reveal themselves only after decoding, even after this handoff.
    const slow = window.setTimeout(reveal, 4000);
    return () => window.clearTimeout(slow);
  }, [viewReady, wallpaperReady]);

  return { setOuterReady, setInnerSettled };
}
