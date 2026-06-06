import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FixtureApp } from './FixtureApp';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

createRoot(root).render(
  <StrictMode>
    <FixtureApp />
  </StrictMode>,
);
