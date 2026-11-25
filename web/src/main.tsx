import React from 'react';
import ReactDOM from 'react-dom/client';
import { desktopPlatform } from './shared/desktop-platform';
import { SettingsToastProvider } from './shared/SettingsToast';
import './styles/dsh-scrollbar.css';
import './styles/app.css';
import './shell/styles/session-view.css';

document.documentElement.dataset.platform = desktopPlatform();

async function start() {
  try {
    const [{ App }] = await Promise.all([import('./App'), window.piApi.waitForStartup?.()]);
    ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>
      <SettingsToastProvider><App /></SettingsToastProvider>
    </React.StrictMode>);
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
