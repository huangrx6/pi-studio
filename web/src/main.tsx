import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/dsh-base.css';
import './styles/dsh-tokens.css';
import './styles/dsh-scrollbar.css';
import './app.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
