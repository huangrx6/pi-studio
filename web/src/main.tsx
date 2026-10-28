import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { loadPreferences, resolveTheme } from './preferences';
import './styles/dsh-scrollbar.css';
import './styles/tokens.css';
import './styles/palette.css';
import './app.css';

// Set the palette before the first React render to avoid a light flash.
document.documentElement.dataset.theme = resolveTheme(loadPreferences().theme);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
