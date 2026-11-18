import React from 'react';
import ReactDOM from 'react-dom/client';
import { desktopPlatform } from './shared/desktop-platform';
import { loadPreferences, resolveTheme } from './shared/preferences';
import './styles/dsh-scrollbar.css';
import './styles/app.css';
import './shell/styles/session-view.css';
import './shell/right-panel/styles/right-panel.css';

const preferences = loadPreferences();
document.documentElement.dataset.platform = desktopPlatform();
document.documentElement.dataset.theme = resolveTheme(preferences.theme);
document.documentElement.dataset.palette = preferences.palette;

async function start() {
  try {
    const [{ App }] = await Promise.all([import('./App'), window.piApi.waitForStartup?.()]);
    ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
  } catch (error) {
    console.error('[pi-studio] renderer startup failed', error);
    document.getElementById('launch-screen')?.remove();
    const root = document.getElementById('root')!;
    root.inert = false;
    root.setAttribute('role', 'alert');
    root.textContent = '启动失败，请重新打开应用。';
  }
}

void start();
