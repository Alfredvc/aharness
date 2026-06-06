export function GraphToolbar({
  nodeCount,
  edgeCount,
  onZoomIn,
  onZoomOut,
  onRefit,
}: {
  nodeCount: number | null;
  edgeCount: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onRefit: () => void;
}) {
  return (
    <div className="graph-toolbar">
      <button type="button" className="tb-btn" onClick={onZoomIn}>
        +
      </button>
      <button type="button" className="tb-btn" onClick={onZoomOut}>
        −
      </button>
      <button type="button" className="tb-btn" onClick={onRefit} title="Fit the whole FSM in view.">
        fit
      </button>
      <span className="tb-meta">
        {nodeCount === null ? 'laying out…' : `${nodeCount} nodes · ${edgeCount} edges`}
      </span>
    </div>
  );
}
