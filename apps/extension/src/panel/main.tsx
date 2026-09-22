import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PanelApp } from './PanelApp';
import './panel.css';

const root = document.getElementById('root');
if (!root) throw new Error('Extension panel root is missing.');
createRoot(root).render(<StrictMode><PanelApp /></StrictMode>);
