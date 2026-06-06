import { useEffect, useState } from 'react';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  return reduced;
}

export function EdgePulse({ pathId }: { pathId: string }) {
  const reduced = usePrefersReducedMotion();
  if (reduced) return null;
  return (
    <circle className="edge-pulse" r={4.5}>
      <animateMotion
        dur="0.9s"
        fill="freeze"
        rotate="auto"
        calcMode="spline"
        keySplines="0.4 0 0.2 1"
        keyTimes="0;1"
      >
        <mpath href={`#${pathId}`} />
      </animateMotion>
      <animate
        attributeName="opacity"
        values="0;1;1;0"
        keyTimes="0;0.12;0.85;1"
        dur="0.9s"
        fill="freeze"
      />
    </circle>
  );
}
