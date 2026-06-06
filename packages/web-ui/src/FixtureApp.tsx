import { AharnessShell } from './App';
import { useFixtureAharnessSession } from './state/fixtureStore';

export function FixtureApp() {
  const session = useFixtureAharnessSession();
  return <AharnessShell session={session} />;
}
