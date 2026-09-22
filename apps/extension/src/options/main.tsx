import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OptionsApp } from './OptionsApp';
import './options.css';

const root = document.getElementById('root');
if (!root) throw new Error('Options root is missing.');
createRoot(root).render(<StrictMode><OptionsApp /></StrictMode>);
