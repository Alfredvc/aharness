import { handleEmbedToggleClick, stopEmbedTogglePointerEvent } from './GraphInternals.js';

export function EmbedToggleControl({
  x,
  y,
  label,
  expanded,
  onToggle,
}: {
  x: number;
  y: number;
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const action = expanded ? 'Collapse' : 'Expand';
  return (
    <foreignObject x={x} y={y} width={24} height={24} className="embed-toggle-host">
      <button
        type="button"
        className="embed-toggle"
        aria-label={`${action} ${label}`}
        onMouseDown={stopEmbedTogglePointerEvent}
        onPointerDown={stopEmbedTogglePointerEvent}
        onClick={(event) => handleEmbedToggleClick(event, onToggle)}
      >
        {expanded ? '−' : '+'}
      </button>
    </foreignObject>
  );
}
