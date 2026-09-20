"use client";

import * as React from "react";
import Link from "next/link";
import Logo from "@/components/Logo";

const SECTIONS = [
  { href: "#what-it-does", label: "What it does" },
  { href: "#cycle", label: "The cycle" },
  { href: "#axes", label: "Axes" },
  { href: "#safety", label: "Safety" },
];

/**
 * Sticky header. Stays transparent over the hero and settles into a solid bar
 * once you scroll; the hairline underneath tracks scroll depth.
 */
export function LandingNav() {
  const [settled, setSettled] = React.useState(false);
  const progressRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onScroll() {
      setSettled(window.scrollY > 24);
      const scrollable =
        document.documentElement.scrollHeight - window.innerHeight;
      const ratio = scrollable > 0 ? window.scrollY / scrollable : 0;
      progressRef.current?.style.setProperty(
        "transform",
        `scaleX(${Math.min(1, Math.max(0, ratio))})`,
      );
    }

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-500 ${
        settled
          ? "border-b border-surface-1 bg-mantle/80 backdrop-blur-xl"
          : "border-b border-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
        <Link href="/" className="flex items-center" aria-label="Jeeva home">
          <Logo height={22} />
        </Link>

        <nav className="hidden items-center gap-7 md:flex">
          {SECTIONS.map((section) => (
            <a
              key={section.href}
              href={section.href}
              className="group relative text-sm text-subtext-1 transition-colors hover:text-text"
            >
              {section.label}
              <span
                aria-hidden
                className="absolute -bottom-1 left-0 h-px w-full origin-left scale-x-0 bg-ember transition-transform duration-300 group-hover:scale-x-100"
              />
            </a>
          ))}
        </nav>

        <Link
          href="/login"
          className="inline-flex items-center justify-center rounded-lg border border-surface-1 bg-surface-0/60 px-4 py-1.5 text-sm font-medium text-text transition-colors hover:border-ember/60 hover:text-ember"
        >
          Sign in
        </Link>
      </div>

      <div
        ref={progressRef}
        aria-hidden
        className="h-px origin-left scale-x-0 bg-gradient-to-r from-peach to-ember"
      />
    </header>
  );
}
