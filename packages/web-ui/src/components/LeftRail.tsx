import type { UiState } from '../state/store';

export function LeftRail({ session }: { session: UiState }) {
  const { state, posture, history } = session;
  return (
    <aside className="left">
      <div className="brand">
        <span>harness</span>
        <span className="dot" aria-hidden />
        <span className="it">·&nbsp;run</span>
      </div>

      <div className="state-block">
        <div className="state-kind">
          <span className="state-kind-dot" aria-hidden />
          <span className="text">
            {state ? state.kind : 'booting'}
            {state?.awaitsOwnerText ? ' · awaits' : ''}
          </span>
        </div>
        <h1 className="state-leaf">
          {state ? renderLeaf(state.leaf) : <span className="ital">connecting…</span>}
        </h1>
        <div className="state-path">{state?.path ?? '—'}</div>
      </div>

      <div className="posture-grid">
        <PostureCell label="awaits" on={posture.isAwaiting} tone="amber" />
        <PostureCell label="terminal" on={posture.isTerminal} tone="mint" />
        <PostureCell label="submitted" on={posture.submittedThisTurn} tone="indigo" />
      </div>

      <div className="history">
        <div className="history-head">
          <span className="label">history</span>
          <span className="label quiet">{history.length} steps</span>
        </div>
        <div className="history-list">
          {history.length === 0 ? (
            <div className="value-mono quiet">no transitions yet</div>
          ) : (
            history.map((h, i) => (
              <div key={i} className="history-item">
                <span className="quiet">{h.from?.split('.').pop() ?? '∅'}</span>
                <span className="arrow">→</span>
                <span className="to">{h.to.split('.').pop()}</span>
                <span style={{ marginLeft: 'auto' }} className="quiet">
                  {h.cause}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  );
}

function PostureCell({
  label,
  on,
  tone,
}: {
  label: string;
  on: boolean;
  tone: 'amber' | 'mint' | 'indigo' | 'plasma';
}) {
  return (
    <div className="posture" data-on={on} data-tone={tone}>
      <span className="k">{label}</span>
      <span className="v">{on ? 'yes' : 'no'}</span>
    </div>
  );
}

function renderLeaf(leaf: string) {
  // Snake_case → italic underscores + a soft break opportunity after each
  // underscore so long state ids wrap on natural boundaries.
  const parts = leaf.split('_');
  return parts.map((p, i) => (
    <span key={i}>
      {p}
      {i < parts.length - 1 ? (
        <>
          <span className="ital">_</span>
          <wbr />
        </>
      ) : null}
    </span>
  ));
}
