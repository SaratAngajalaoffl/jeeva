"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LayoutDashboard, LineChart, Wallet, ListOrdered, LogOut } from "lucide-react";
import { logout } from "@/lib/api";
import { EngineModeToggle } from "./EngineModeToggle";
import Logo from "./Logo";

const NAV_LINKS = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/markets", label: "Markets", icon: LineChart },
  { href: "/dashboard/wallet", label: "Wallet", icon: Wallet },
  { href: "/dashboard/decisions", label: "Positions", icon: ListOrdered },
];

export function SiteHeader({
  onLogout,
  children,
}: {
  onLogout?: () => void;
  children?: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    if (onLogout) {
      onLogout();
      return;
    }
    await logout();
    router.push("/login");
  }

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-surface-1 bg-mantle/80 px-4 py-6">
        <Link href="/dashboard" className="flex items-center justify-center px-2 py-2">
          <Logo height={36} />
        </Link>
        <nav className="mt-8 flex flex-col gap-1 text-sm">
          {NAV_LINKS.map((link) => {
            const active = pathname === link.href;
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`flex items-center gap-2 rounded-md px-3 py-1.5 transition-colors ${
                  active
                    ? "bg-surface-0 text-ember"
                    : "text-subtext-1 hover:text-text"
                }`}
              >
                <Icon size={16} />
                {link.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto flex flex-col gap-3">
          <EngineModeToggle />
        </div>
        <button
          onClick={handleLogout}
          className="mt-2 flex items-center justify-center gap-2 rounded-md border border-surface-1 px-3 py-1.5 text-sm text-subtext-1 transition-colors hover:border-ember/60 hover:text-ember"
        >
          <LogOut size={16} />
          Log out
        </button>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
