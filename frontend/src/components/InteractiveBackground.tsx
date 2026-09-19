"use client";

import * as React from "react";

import { useMouseReactiveGradient } from "@/components/hooks/use-mouse-reactive-gradient";

/** Interactive gradient layer — client-only (pointer + rAF). Sits behind page content. */
export function InteractiveBackground() {
  const gradientRef = React.useRef<HTMLDivElement>(null);
  useMouseReactiveGradient(gradientRef);

  return (
    <div
      ref={gradientRef}
      className="pointer-events-none fixed inset-0 overflow-hidden [--g1x:0.5] [--g1y:0.45] [--g2x:0.55] [--g2y:0.5]"
      aria-hidden
    >
      <div className="absolute inset-0 bg-crust" />
      <div
        className="absolute h-[min(85vw,520px)] w-[min(85vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.42]"
        style={{
          left: "calc(var(--g1x) * 100%)",
          top: "calc(var(--g1y) * 100%)",
          background:
            "radial-gradient(circle closest-side, rgb(255 59 59 / 0.9) 0%, rgb(255 59 59 / 0.15) 45%, transparent 70%)",
          filter: "blur(80px)",
        }}
      />
      <div
        className="absolute h-[min(70vw,420px)] w-[min(70vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.38]"
        style={{
          left: "calc(var(--g2x) * 100%)",
          top: "calc(var(--g2y) * 100%)",
          background:
            "radial-gradient(circle closest-side, rgb(255 159 90 / 0.85) 0%, rgb(255 159 90 / 0.12) 50%, transparent 72%)",
          filter: "blur(72px)",
        }}
      />
      <div
        className="absolute h-[min(55vw,320px)] w-[min(55vw,320px)] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.24]"
        style={{
          left: "calc((1 - var(--g1x)) * 100%)",
          top: "calc((1 - var(--g1y)) * 100%)",
          background:
            "radial-gradient(circle closest-side, rgb(255 200 87 / 0.75) 0%, transparent 70%)",
          filter: "blur(64px)",
        }}
      />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_40%,transparent_0%,rgb(10_6_7/0.85)_100%)]" />
      <div
        className="absolute inset-0 opacity-[0.22]"
        style={{
          backgroundImage: `linear-gradient(rgb(246 233 234 / 0.06) 1px, transparent 1px),
              linear-gradient(90deg, rgb(246 233 234 / 0.06) 1px, transparent 1px)`,
          backgroundSize: "48px 48px",
          maskImage:
            "radial-gradient(ellipse 70% 60% at 50% 45%, black 20%, transparent 75%)",
        }}
      />
    </div>
  );
}
