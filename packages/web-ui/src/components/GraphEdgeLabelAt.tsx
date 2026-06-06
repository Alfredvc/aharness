import type { PointerEvent as ReactPointerEvent } from 'react';
import { truncateEdgeLabel, type EdgeLabelRenderItem } from './GraphInternals.js';

export function EdgeLabelAt({
  item,
  title,
  onPointerEnter,
  onPointerMove,
  onPointerLeave,
}: {
  item: EdgeLabelRenderItem;
  title: string;
  onPointerEnter: (event: ReactPointerEvent<SVGGElement>) => void;
  onPointerMove: (event: ReactPointerEvent<SVGGElement>) => void;
  onPointerLeave: () => void;
}) {
  const label = truncateEdgeLabel(item.label, item.width);
  return (
    <g
      className={`edge-label-group ${item.grouped ? 'summary' : ''}`}
      transform={`translate(${item.x},${item.y})`}
      aria-label={title}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <rect
        x={-item.width / 2}
        y={-8}
        width={item.width}
        height={16}
        rx={8}
        ry={8}
        className="edge-label-bg"
      />
      <title>{title}</title>
      <text className="edge-label" x={0} y={4} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}
