// Executed in the document head, before the launch artwork can paint.
(() => {
  let preferences;
  try {
    preferences = JSON.parse(localStorage.getItem('pi-studio:preferences'));
  } catch {
    // Blocked storage and invalid JSON use the same defaults as the main window.
  }
  const theme = preferences?.theme;
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.palette = ['ocean', 'amber', 'berry'].includes(preferences?.palette)
    ? preferences.palette : 'ocean';
})();
