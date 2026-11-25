import { createRoot } from 'react-dom/client';
import { ExcalidrawPluginApp } from './ExcalidrawPluginApp';
import './styles.css';

Object.assign(window, {
  EXCALIDRAW_ASSET_PATH: new URL('./excalidraw-assets/', document.baseURI).href,
});

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<ExcalidrawPluginApp />);
}
