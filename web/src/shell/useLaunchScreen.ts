import { useEffect, useState } from 'react';

export function useLaunchScreen(viewReady: boolean, wallpaperUrl: string | undefined, showInside: boolean) {
  const [outerReady, setOuterReady] = useState('');
  const [innerSettled, setInnerSettled] = useState('');
  const wallpaperReady = !wallpaperUrl || (outerReady === wallpaperUrl && (!showInside || innerSettled === wallpaperUrl));

  useEffect(() => {
    const screen = document.getElementById('launch-screen');
    if (!screen || screen.dataset.leaving || !viewReady) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let current = true;

    const reveal = async () => {
      // This animation starts at first paint. A ready workspace waits only for
      // the part of the writing and its final hold that is still on screen.
      const writing = screen.querySelector('.launch-cursor')?.getAnimations().find(
        animation => animation instanceof CSSAnimation && animation.animationName === 'launch-write-cursor',
      );
      if (writing && !reducedMotion.matches) {
        await writing.finished.catch(() => {}); // Reduced motion cancels the CSS animation.
      }
      if (!current || !screen.isConnected || screen.dataset.leaving) return;
      screen.dataset.leaving = 'true';
      if (!reducedMotion.matches) {
        const fade = screen.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 240,
          easing: 'ease-in-out',
          fill: 'forwards',
        });
        const skipFade = () => { if (reducedMotion.matches) fade.finish(); };
        reducedMotion.addEventListener('change', skipFade);
        try {
          await fade.finished;
        } catch {
          // A cancelled exit still hands input to the ready workspace.
        } finally {
          reducedMotion.removeEventListener('change', skipFade);
        }
      }
      if (!screen.isConnected) return;
      screen.remove();
      document.getElementById('root')!.inert = false;
      window.piApi.workspaceReady?.();
    };

    let slowWallpaper: number | undefined;
    if (wallpaperReady) void reveal();
    else slowWallpaper = window.setTimeout(reveal, 4000);
    return () => {
      current = false;
      window.clearTimeout(slowWallpaper);
    };
  }, [viewReady, wallpaperReady]);

  return { setOuterReady, setInnerSettled };
}
