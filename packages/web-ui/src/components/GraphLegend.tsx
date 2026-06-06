import { useState } from 'react';
import type { LegendItem } from './graphInteraction.js';

export function GraphLegend({ items }: { items: LegendItem[] }) {
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('aharness-ui.legend.open') === 'true';
  });

  function toggle() {
    setOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem('aharness-ui.legend.open', String(next));
      } catch {
        /* localStorage unavailable, so collapse state stays in-memory only. */
      }
      return next;
    });
  }

  return (
    <aside className={`legend ${open ? '' : 'collapsed'}`} aria-label="Legend">
      <button className="legend-toggle" type="button" aria-expanded={open} onClick={toggle}>
        <span>legend</span>
        <span className="chev" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div className="legend-body">
          {items.map((item) => (
            <div className="legend-row" key={item.id}>
              <LegendSwatch className={item.swatch} />
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

function LegendSwatch({ className }: { className: string }) {
  return (
    <span className={`legend-swatch ${className}`}>
      {className.includes('sw-active') ? (
        <>
          <span className="sw-halo" />
          <span className="sw-halo sw-halo-2" />
        </>
      ) : null}
      {className.includes('sw-collapsed-embed') ? <span className="sw-embed-glyph" /> : null}
      {className.includes('sw-descendant') ? (
        <>
          <span className="sw-descendant-ring" />
          <span className="sw-descendant-dot" />
        </>
      ) : null}
      {className.includes('sw-edge-fired') ? <span className="sw-edge-dot" /> : null}
    </span>
  );
}
