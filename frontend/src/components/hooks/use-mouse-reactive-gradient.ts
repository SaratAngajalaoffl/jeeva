import * as React from "react";

/**
 * Drives `--g1x`, `--g1y`, `--g2x`, `--g2y` on the given element from pointer position
 * (smoothed layers). Respects `prefers-reduced-motion: reduce`.
 */
export function useMouseReactiveGradient(
  containerRef: React.RefObject<HTMLElement | null>,
) {
  const targetRef = React.useRef({ x: 0.5, y: 0.5 });
  const smoothRef = React.useRef({ x: 0.5, y: 0.5 });
  const smooth2Ref = React.useRef({ x: 0.35, y: 0.55 });
  const reducedRef = React.useRef(false);

  React.useEffect(() => {
    reducedRef.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const el = containerRef.current;
    if (!el) return;

    const setVars = (
      a: { x: number; y: number },
      b: { x: number; y: number },
    ) => {
      el.style.setProperty("--g1x", String(a.x));
      el.style.setProperty("--g1y", String(a.y));
      el.style.setProperty("--g2x", String(b.x));
      el.style.setProperty("--g2y", String(b.y));
    };

    if (reducedRef.current) {
      setVars({ x: 0.5, y: 0.45 }, { x: 0.55, y: 0.5 });
      return;
    }

    const onMove = (e: PointerEvent) => {
      targetRef.current = {
        x: e.clientX / window.innerWidth,
        y: e.clientY / window.innerHeight,
      };
    };

    window.addEventListener("pointermove", onMove, { passive: true });

    let frame = 0;
    const tick = () => {
      const t = targetRef.current;
      const s1 = smoothRef.current;
      const s2 = smooth2Ref.current;
      const k1 = 0.085;
      const k2 = 0.045;
      smoothRef.current = {
        x: s1.x + (t.x - s1.x) * k1,
        y: s1.y + (t.y - s1.y) * k1,
      };
      smooth2Ref.current = {
        x: s2.x + (t.x - s2.x) * k2,
        y: s2.y + (t.y - s2.y) * k2,
      };
      setVars(smoothRef.current, smooth2Ref.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, [containerRef]);
}
