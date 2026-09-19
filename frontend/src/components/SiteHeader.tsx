"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINKS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/markets", label: "Markets" },
  { href: "/dashboard/wallet", label: "Wallet" },
  { href: "/dashboard/decisions", label: "Positions" },
];

export function SiteHeader({
  onLogout,
  children,
}: {
  onLogout?: () => void;
  children?: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-surface-1 bg-mantle/80 px-4 py-6">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 px-2 font-semibold tracking-tight text-text"
        >
          <span className="inline-block h-2 w-2 rounded-full bg-ember shadow-[0_0_8px_theme(colors.ember)]" />
          Jeeva
        </Link>
        <nav className="mt-8 flex flex-col gap-1 text-sm">
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
        </nav>
        {onLogout && (
          <button
            onClick={onLogout}
            className="mt-auto rounded-md border border-surface-1 px-3 py-1.5 text-sm text-subtext-1 transition-colors hover:border-ember/60 hover:text-ember"
          >
            Log out
          </button>
        )}
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
