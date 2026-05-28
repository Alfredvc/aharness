import { useEffect, useState } from 'react';
import { readBootToken, useHarnessSession } from './state/store';
import { Graph } from './components/Graph';
import { ActivePanel } from './components/ActivePanel';
import { BootSkeleton } from './components/BootSkeleton';
import { TurnRibbon } from './components/TurnRibbon';
import './components/components.css';

export function App() {
  const session = useHarnessSession(readBootToken());

  return <HarnessShell session={session} />;
}

export function HarnessShell({ session }: { session: ReturnType<typeof useHarnessSession> }) {
  const [helpOpen, setHelpOpen] = useState(false);
  const showBoot = !session.state;

  useEffect(() => {
    document.title = session.mode === 'inspect' ? 'harness · inspect' : 'harness · run';
  }, [session.mode]);

  // Global keybinds: A/D for top approval, J/K nav, ? for help, V dev mode.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ignore when typing in inputs.
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.key === '?') {
        setHelpOpen((o) => !o);
        return;
      }
      if (e.key === 'v' || e.key === 'V') {
        session.toggleDevMode();
        return;
      }
      const topApproval = session.pending.fileApprovals[0] ?? session.pending.cmdApprovals[0];
      if (!topApproval) return;
      if (e.key === 'a' || e.key === 'A') {
        void session
          .reply({ kind: 'approval', requestId: topApproval.id, decision: 'accept' })
          .catch(() => undefined);
      } else if (e.key === 'd' || e.key === 'D') {
        void session
          .reply({ kind: 'approval', requestId: topApproval.id, decision: 'decline' })
          .catch(() => undefined);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  return (
    <div className="shell">
      <TopHeader session={session} onHelp={() => setHelpOpen(true)} />
      {session.connection === 'lost' && session.state ? <ConnectionBanner /> : null}
      {showBoot ? (
        <BootSkeleton connection={session.connection} />
      ) : (
        <main className="main">
          <div className="graph-pane">
            <Graph
              topology={session.topology}
              activeStateId={session.state?.path ?? null}
              history={session.history}
              awaitsOwner={session.posture.isAwaiting}
              isTerminal={session.posture.isTerminal}
              onNodeClick={(id) => {
                // Click on a node freezes scope to that path; ActivePanel
                // renders all visits to it, separated by visit headers.
                if (session.mode === 'inspect' || session.history.some((h) => h.to === id)) {
                  session.setScope(id);
                }
              }}
            />
          </div>
          <div className="panel-pane">
            <ActivePanel session={session} />
          </div>
        </main>
      )}
      {showBoot ? null : <TurnRibbon session={session} />}
      {helpOpen ? <HelpOverlay onClose={() => setHelpOpen(false)} /> : null}
    </div>
  );
}

function TopHeader({
  session,
  onHelp,
}: {
  session: ReturnType<typeof useHarnessSession>;
  onHelp: () => void;
}) {
  const { run, posture, turns, devMode, toggleDevMode } = session;
  const posturePill =
    session.connection === 'connecting'
      ? { label: 'connecting', tone: 'plasma' }
      : session.connection === 'lost'
        ? { label: 'lost', tone: 'rose' }
        : session.mode === 'inspect'
          ? { label: 'inspect', tone: 'indigo' }
          : posture.isTerminal
            ? { label: 'terminal', tone: 'mint' }
            : posture.isAwaiting
              ? { label: 'awaiting owner', tone: 'amber' }
              : { label: 'live', tone: 'indigo' };
  return (
    <header className="top">
      <div className="brand">
        <span className="brand-name">harness</span>
        <span className="brand-dot" data-tone={posturePill.tone} aria-hidden />
        <span className="brand-it">·&nbsp;{session.mode === 'inspect' ? 'inspect' : 'run'}</span>
      </div>
      <div className="top-meta">
        <span className="pill" data-tone={posturePill.tone}>
          {posturePill.label}
        </span>
        <span className="top-file">{run?.fsmFile ?? 'loading'}</span>
        <span className="top-sep" aria-hidden>
          /
        </span>
        <span className="top-meta-row">
          <span className="k">run</span>
          <span className="v">{run?.runId ?? 'pending'}</span>
        </span>
        <span className="top-meta-row">
          <span className="k">codex</span>
          <span className="v">{run?.codexPin ?? 'pending'}</span>
        </span>
        <span className="top-meta-row">
          <span className="k">turns</span>
          <span className="v">{turns.length}</span>
        </span>
      </div>
      <div className="top-actions">
        <button
          className={`top-btn ${devMode ? 'on' : ''}`}
          onClick={toggleDevMode}
          title="Show internal events (harness_submit, framework notes, synthetic orientation)."
        >
          dev <kbd>V</kbd>
        </button>
        <button className="top-btn" onClick={onHelp} title="Keyboard shortcuts">
          ? help
        </button>
      </div>
    </header>
  );
}

function ConnectionBanner() {
  return (
    <div className="conn-banner">
      <span className="led" aria-hidden /> connection lost · foreground run ended · artifacts remain
      inspectable
    </div>
  );
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="help-overlay" onClick={onClose}>
      <div className="help-card" onClick={(e) => e.stopPropagation()}>
        <header className="help-head">
          <span>shortcuts</span>
          <button onClick={onClose} className="x">
            ×
          </button>
        </header>
        <dl className="help-list">
          <dt>
            <kbd>A</kbd>
          </dt>
          <dd>accept top approval</dd>
          <dt>
            <kbd>D</kbd>
          </dt>
          <dd>decline top approval</dd>
          <dt>
            <kbd>V</kbd>
          </dt>
          <dd>toggle dev mode (show internals)</dd>
          <dt>
            <kbd>?</kbd>
          </dt>
          <dd>this help</dd>
          <dt>
            <kbd>⌘</kbd>+<kbd>↵</kbd>
          </dt>
          <dd>send composer / submit multi-question</dd>
          <dt>
            <kbd>1</kbd>–<kbd>9</kbd>
          </dt>
          <dd>jump to choice (when slot is choice)</dd>
          <dt>
            <kbd>↑</kbd> / <kbd>↓</kbd>
          </dt>
          <dd>nav choice list</dd>
        </dl>
        <footer className="help-foot quiet">click anywhere to close</footer>
      </div>
    </div>
  );
}
