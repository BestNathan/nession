import {createRoot} from 'react-dom/client';
import {BrowserWorkflowsApp} from './App.tsx';

const site = document.querySelector('.site');
if (!site) throw new Error('Pages site root is missing');
createRoot(site).render(<BrowserWorkflowsApp />);
