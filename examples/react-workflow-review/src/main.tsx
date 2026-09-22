import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkflowReviewApp } from './WorkflowReviewApp';
import './workflow-review.css';

const root = document.getElementById('root');
if (!root) throw new Error('Workflow example root is missing.');
createRoot(root).render(<StrictMode><WorkflowReviewApp /></StrictMode>);
