import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

// Explicitly tear down the pre-React boot screen before mounting so React
// never warns about replacing existing children.
const preboot = document.getElementById('aharness-preboot');
if (preboot && preboot.parentElement) preboot.parentElement.removeChild(preboot);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
