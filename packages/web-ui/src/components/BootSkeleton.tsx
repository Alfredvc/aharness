import { useEffect, useState } from 'react';

type Props = {
  connection: 'live' | 'connecting' | 'lost';
};

const STAGES = [
  { id: 'spawn', label: 'spawning codex app-server', cap: 1500 },
  { id: 'ws', label: 'opening websocket', cap: 1500 },
  { id: 'thread', label: 'opening fresh thread', cap: 2500 },
  { id: 'state', label: 'awaiting first state', cap: Infinity },
] as const;

export function BootSkeleton({ connection }: Props) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (connection === 'lost') return;
    const id = window.setInterval(() => setMs((v) => v + 120), 120);
    return () => window.clearInterval(id);
  }, [connection]);

  // Find first stage whose cumulative cap exceeds elapsed.
  let cumulative = 0;
  let activeIdx = STAGES.length - 1;
  for (let i = 0; i < STAGES.length; i++) {
    cumulative += STAGES[i].cap;
    if (ms < cumulative) {
      activeIdx = i;
      break;
    }
  }

  return (
    <section className="boot-skeleton" aria-busy="true">
      <div className="boot-card">
        <div className="boot-orbit" aria-hidden>
          <span className="boot-orbit-core" />
          <span className="boot-orbit-ring r1" />
          <span className="boot-orbit-ring r2" />
          <span className="boot-orbit-ring r3" />
        </div>
        <div className="boot-eyebrow">aharness · headless</div>
        <h1 className="boot-title">
          {connection === 'lost' ? 'connection lost' : 'spinning up the run'}
        </h1>
        <p className="boot-sub">
          {connection === 'lost'
            ? 'The foreground aharness run ended. Run artifacts remain inspectable.'
            : 'Codex is starting in the background. State and topology will appear here as soon as the first frame lands.'}
        </p>
        <ol className="boot-stages">
          {STAGES.map((stage, i) => {
            const status =
              connection === 'lost'
                ? i < activeIdx
                  ? 'done'
                  : i === activeIdx
                    ? 'lost'
                    : 'pending'
                : i < activeIdx
                  ? 'done'
                  : i === activeIdx
                    ? 'active'
                    : 'pending';
            return (
              <li key={stage.id} className="boot-stage" data-status={status}>
                <span className="bs-bullet" aria-hidden>
                  {status === 'done' ? '✓' : status === 'lost' ? '!' : ''}
                </span>
                <span className="bs-label">{stage.label}</span>
                {status === 'active' ? (
                  <span className="bs-ellipsis" aria-hidden>
                    <i />
                    <i />
                    <i />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
        <div className="boot-hint">
          Tip: press <kbd>?</kbd> any time to see shortcuts.
        </div>
      </div>
    </section>
  );
}
