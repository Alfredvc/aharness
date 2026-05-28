import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HarnessShell } from './App';
import { useFixtureHarnessSession } from './state/fixtureStore';
import './styles/global.css';

function FixtureApp() {
  const session = useFixtureHarnessSession();
  return <HarnessShell session={session} />;
}

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

createRoot(root).render(
  <StrictMode>
    <FixtureApp />
  </StrictMode>,
);
