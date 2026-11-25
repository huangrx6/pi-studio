import { createRoot } from 'react-dom/client';
import { NotesApp } from './NotesApp';
import './styles.css';

createRoot(document.getElementById('root')!).render(<NotesApp />);
