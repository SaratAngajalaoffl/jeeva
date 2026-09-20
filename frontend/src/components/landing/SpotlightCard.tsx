"use client";

import * as React from "react";

/**
 * A card that lights up under the pointer: a soft ember glow follows the
 * cursor and the border picks up the same position, so a grid of these reads
 * as one surface being lit rather than a row of separate hover states.
 *
 * Position is written straight to CSS custom properties — no React state, so
 * pointer movement never re-renders.
 */
export function SpotlightCard({
  className = "",
  contentClassName = "",
  children,
}: {
  className?: string;
  /**
   * Applied to the wrapper the children actually sit in. Needed when the
   * content has to fill the card — e.g. `flex h-full flex-col` so a footer
   * can `mt-auto` to the bottom edge.
   */
  contentClassName?: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--sx", `${event.clientX - rect.left}px`);
    el.style.setProperty("--sy", `${event.clientY - rect.top}px`);
    el.style.setProperty("--so", "1");
  }

  function handlePointerLeave() {
    ref.current?.style.setProperty("--so", "0");
  }

  return (
    <div
      ref={ref}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className={`group relative overflow-hidden rounded-2xl border border-surface-1 bg-surface-0/40 backdrop-blur transition-colors duration-500 [--so:0] [--sx:50%] [--sy:50%] hover:border-ember/30 ${className}`}
    >
      {/* Glow under the pointer. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[var(--so)] transition-opacity duration-500"
        style={{
          background:
            "radial-gradient(260px circle at var(--sx) var(--sy), rgb(255 59 59 / 0.12), transparent 65%)",
        }}
      />
      {/* Border highlight, masked to a 1px ring. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-2xl opacity-[var(--so)] transition-opacity duration-500"
        style={{
          background:
            "radial-gradient(220px circle at var(--sx) var(--sy), rgb(255 184 77 / 0.55), transparent 60%)",
          WebkitMask:
            "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
          mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
          WebkitMaskComposite: "xor",
          maskComposite: "exclude",
          padding: 1,
        }}
      />
      <div className={`relative ${contentClassName}`}>{children}</div>
    </div>
  );
}
