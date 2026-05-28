import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AharnessShell } from './App';
import { useFixtureAharnessSession } from './state/fixtureStore';
import './styles/global.css';

function FixtureApp() {
  const session = useFixtureAharnessSession();
  return <AharnessShell session={session} />;
}

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

createRoot(root).render(
  <StrictMode>
    <FixtureApp />
  </StrictMode>,
);
