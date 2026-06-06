import { useEffect, useRef, useState } from 'react';
import { isReadOnlyMode, readBootToken, useAharnessSession, type UiState } from './state/store';
import { Graph } from './components/Graph';
import { ActivePanel } from './components/ActivePanel';
import { BootSkeleton } from './components/BootSkeleton';
import { FinalOverviewModal } from './components/FinalOverviewModal';
import { RunStatsBar } from './components/RunStatsBar';
import './components/components.css';

type ShellStatus = {
  label: string;
  tone: 'indigo' | 'amber' | 'mint' | 'plasma' | 'rose';
  terminalish: boolean;
};

type ShellSession = ReturnType<typeof useAharnessSession>;

const overlayDialogStyle = {
  border: 0,
  margin: 0,
  maxHeight: 'none',
  maxWidth: 'none',
  padding: 0,
} as const;
const dialogBackdropButtonStyle = {
  background: 'transparent',
  border: 0,
  cursor: 'default',
  inset: 0,
  padding: 0,
  position: 'fixed',
  zIndex: 0,
} as const;
const dialogContentStyle = {
  position: 'relative',
  zIndex: 1,
} as const;

function terminalOutcome(session: UiState): 'success' | 'failure' | null {
  const completionOutcome = session.completionStats?.outcome;
  if (completionOutcome === 'success' || completionOutcome === 'failure') return completionOutcome;
  const status = session.aggregateStats.status;
  if (status === 'success' || status === 'completed') return 'success';
  if (status === 'failed' || status === 'failure') return 'failure';
  return null;
}

function shellStatus(session: UiState): ShellStatus {
  const outcome = terminalOutcome(session);
  if (outcome === 'success') return { label: 'completed', tone: 'mint', terminalish: true };
  if (outcome === 'failure') return { label: 'failed', tone: 'rose', terminalish: true };
  if (session.posture.isTerminal) return { label: 'terminal', tone: 'mint', terminalish: true };
  if (session.connection === 'connecting') {
    return { label: 'connecting', tone: 'plasma', terminalish: false };
  }
  if (session.connection === 'lost') return { label: 'lost', tone: 'rose', terminalish: false };
  if (isReadOnlyMode(session.mode)) {
    return { label: session.mode, tone: 'indigo', terminalish: false };
  }
  if (session.posture.isAwaiting) {
    return { label: 'awaiting owner', tone: 'amber', terminalish: false };
  }
  return { label: 'live', tone: 'indigo', terminalish: false };
}

export function documentTitleForMode(mode: UiState['mode']): string {
  return `aharness - ${mode}`;
}

function runStatsSession(session: ShellSession, status: ShellStatus): ShellSession {
  if (!status.terminalish) return session;
  return {
    ...session,
    connection: session.connection === 'lost' ? 'live' : session.connection,
    posture: { ...session.posture, isTerminal: true },
  };
}

export function App() {
  const session = useAharnessSession(readBootToken());

  return <AharnessShell session={session} />;
}

export function AharnessShell({ session }: { session: ReturnType<typeof useAharnessSession> }) {
  const [helpOpen, setHelpOpen] = useState(false);
  const showBoot = !session.state;
  const status = shellStatus(session);
  const statsSession = runStatsSession(session, status);

  useEffect(() => {
    document.title = documentTitleForMode(session.mode);
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
      if (e.key === 'Escape' && session.posture.isTerminal && session.finalOverview.open) {
        session.dismissFinalOverview();
        return;
      }
      if (e.key === 'v' || e.key === 'V') {
        session.toggleDevMode();
        return;
      }
      if (isReadOnlyMode(session.mode)) return;
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
      {session.connection === 'lost' && session.state && !status.terminalish ? (
        <ConnectionBanner />
      ) : null}
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
              onSelectionClear={() => session.setScope(null)}
            />
          </div>
          <div className="panel-pane">
            <ActivePanel session={session} />
          </div>
        </main>
      )}
      {showBoot ? null : <RunStatsBar session={statsSession} variant="bottom" />}
      {session.posture.isTerminal && session.finalOverview.open ? (
        <FinalOverviewModal
          completionStats={session.completionStats}
          loading={session.finalOverview.loading}
          error={session.finalOverview.error}
          onClose={session.dismissFinalOverview}
        />
      ) : null}
      {helpOpen ? <HelpOverlay onClose={() => setHelpOpen(false)} /> : null}
    </div>
  );
}

function TopHeader({
  session,
  onHelp,
}: {
  session: ReturnType<typeof useAharnessSession>;
  onHelp: () => void;
}) {
  const { run, posture, devMode, toggleDevMode } = session;
  const posturePill = shellStatus(session);
  return (
    <header className="top">
      <div className="brand">
        <span className="brand-name">aharness</span>
        <span className="brand-dot" data-tone={posturePill.tone} aria-hidden />
        <span className="brand-it">·&nbsp;{session.mode}</span>
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
        <RunStatsBar session={session} variant="header" />
      </div>
      <div className="top-actions">
        {posture.isTerminal ? (
          <button
            className="top-btn"
            type="button"
            onClick={session.openFinalOverview}
            title="Open final run summary"
          >
            summary
          </button>
        ) : null}
        <button
          className={`top-btn ${devMode ? 'on' : ''}`}
          type="button"
          onClick={toggleDevMode}
          title="Show protocol rows, state markers, lifecycle rows, and framework notes."
        >
          dev <kbd>V</kbd>
        </button>
        <button className="top-btn" type="button" onClick={onHelp} title="Keyboard shortcuts">
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
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    if (typeof dialog.showModal === 'function') {
      try {
        if (!dialog.open) dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    } else {
      dialog.setAttribute('open', '');
    }

    return () => {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="help-overlay"
      aria-label="Keyboard shortcuts"
      style={overlayDialogStyle}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <section className="help-card" style={dialogContentStyle}>
        <header className="help-head">
          <span>shortcuts</span>
          <button type="button" onClick={onClose} className="x">
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
      </section>
      <button
        type="button"
        aria-label="Close shortcuts"
        style={dialogBackdropButtonStyle}
        tabIndex={-1}
        onClick={onClose}
      />
    </dialog>
  );
}
