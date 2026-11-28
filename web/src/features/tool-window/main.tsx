import { createRoot } from 'react-dom/client';
import { SettingsToastProvider } from '../../shared/SettingsToast';
import { desktopPlatform } from '../../shared/desktop-platform';
import '../../styles/dsh-scrollbar.css';
import '../../styles/app.css';
import { ToolWindow } from './ToolWindow';

document.documentElement.dataset.platform = desktopPlatform();
createRoot(document.getElementById('root')!).render(
  <SettingsToastProvider><ToolWindow /></SettingsToastProvider>,
);
