import { useEffect } from 'react';

/**
 * Mirrors the native window chrome onto the document root.
 *
 * Native fullscreen hides the macOS traffic lights, so the shell must stop
 * reserving their gutter; CSS reads the attribute and collapses that band.
 * The state is presentation-only and never reaches application state.
 */
export function useWindowChrome() {
  useEffect(() => {
    const root = document.documentElement;
    const apply = (state: { fullscreen: boolean } | undefined) => {
      root.dataset.windowFullscreen = state?.fullscreen ? 'true' : 'false';
    };
    const unsubscribe = window.piApi.onWindowState(apply);
    void window.piApi.windowState().then(apply).catch(() => {
      // Browser-only development has no native chrome; stay in the windowed layout.
    });
    return () => { unsubscribe(); };
  }, []);
}
