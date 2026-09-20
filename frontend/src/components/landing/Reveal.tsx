"use client";

import * as React from "react";

type RevealProps = {
  children: React.ReactNode;
  className?: string;
  /** Stagger, in seconds, before this element animates in. */
  delay?: number;
  /** Which direction the element travels from. */
  from?: "up" | "left" | "right" | "zoom";
  id?: string;
};

/**
 * Reveals its children once they scroll into view, then stops observing.
 * The visible/hidden state lives in CSS (`.jv-reveal`, see globals.css) and is
 * flipped by a data attribute, so there is nothing to mismatch on hydration
 * and `prefers-reduced-motion` is handled without a JS media query.
 */
export function Reveal({
  children,
  className = "",
  delay = 0,
  from = "up",
  id,
}: RevealProps) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // No observer (older browsers, jsdom): show everything immediately.
    if (typeof IntersectionObserver === "undefined") {
      el.dataset.shown = "true";
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.shown = "true";
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.15 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      id={id}
      className={`jv-reveal jv-reveal-${from} ${className}`}
      style={delay ? { transitionDelay: `${delay}s` } : undefined}
    >
      {children}
    </div>
  );
}
