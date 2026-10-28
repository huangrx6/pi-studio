/**
 * 渲染进程入口：加载全局样式并把 <App /> 挂到 #root。
 *
 * 关键时序：主题必须在首次 React 渲染之前写到 `<html data-theme>`，
 * 否则第一帧会先按 CSS 默认色绘制，出现浅色闪屏（FOUC）。
 *
 * 与主进程的关系：本文件不直接调用 IPC。主题偏好的持久化、原生窗口底色同步
 * 都由 App 负责（`window.piApi.setTheme`），这里只读取 localStorage 里的偏好。
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { loadPreferences, resolveTheme } from './preferences';
import './styles/dsh-scrollbar.css';
import './styles/tokens.css';
import './styles/palette.css';
import './app.css';

// 先应用主题再 render：resolveTheme 会把 system 解析成当前实际的 light / dark。
document.documentElement.dataset.theme = resolveTheme(loadPreferences().theme);

// StrictMode 只在开发期重复执行副作用以暴露问题，不改变生产环境行为。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
