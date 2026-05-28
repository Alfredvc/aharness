import { useMemo, useState } from 'react';
import type { UiState } from '../state/store';

type Props = { session: UiState };

const COLORS: Record<string, string> = {
  stop: 'var(--mint)',
  tool_calls: 'var(--indigo)',
  length: 'var(--amber)',
  abort: 'var(--rose)',
};

export function TurnRibbon({ session }: Props) {
  const { turns } = session;
  const [hover, setHover] = useState<number | null>(null);

  const max = useMemo(() => {
    if (turns.length === 0) return 1;
    return turns.length;
  }, [turns]);

  return (
    <div className="ribbon">
      <div className="ribbon-track">
        {turns.length === 0 ? (
          <span className="ribbon-empty quiet">no turns completed yet</span>
        ) : (
          turns.map((t, i) => {
            const h = 8 + Math.round(((i + 1) / max) * 20);
            return (
              <div
                key={t.turnId}
                className="ribbon-bar"
                style={{
                  height: `${h}px`,
                  background: COLORS[t.finishReason] ?? 'var(--ink-quiet)',
                }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                title={`${t.turnId} · ${t.finishReason}`}
              />
            );
          })
        )}
      </div>
      {hover !== null && turns[hover] ? (
        <div className="ribbon-tip">
          <span className="mono">{turns[hover].turnId}</span>
          <span className="mono">{turns[hover].finishReason}</span>
        </div>
      ) : null}
    </div>
  );
}
