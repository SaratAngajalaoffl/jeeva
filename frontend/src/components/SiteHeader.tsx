"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINKS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/markets", label: "Markets" },
  { href: "/dashboard/wallet", label: "Wallet" },
  { href: "/dashboard/decisions", label: "Positions" },
];

export function SiteHeader({ onLogout }: { onLogout?: () => void }) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 border-b border-surface-1 bg-mantle/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold tracking-tight text-text">
          <span className="inline-block h-2 w-2 rounded-full bg-ember shadow-[0_0_8px_theme(colors.ember)]" />
          Jeeva
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {NAV_LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded-md px-3 py-1.5 transition-colors ${
                  active
                    ? "bg-surface-0 text-ember"
                    : "text-subtext-1 hover:text-text"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
          {onLogout && (
            <button
              onClick={onLogout}
              className="ml-2 rounded-md border border-surface-1 px-3 py-1.5 text-subtext-1 transition-colors hover:border-ember/60 hover:text-ember"
            >
              Log out
            </button>
          )}
        </nav>
      </div>
    </header>
  );
}
