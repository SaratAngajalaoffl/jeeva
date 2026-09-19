"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { checkSession, logout } from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import { Card } from "@/components/ui";

const LINKS = [
  {
    href: "/dashboard/markets",
    title: "Markets",
    description: "Configure trading and sampling for each perp.",
  },
  {
    href: "/dashboard/wallet",
    title: "Mock wallet",
    description: "Balance, P&L, and funding payments.",
  },
  {
    href: "/dashboard/decisions",
    title: "Positions & decisions",
    description: "Live positions and the Jev decision log.",
  },
];

export default function DashboardPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    checkSession().then((authenticated) => {
      if (cancelled) return;
      if (!authenticated) {
        router.replace("/login");
        return;
      }
      setChecking(false);
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (checking) {
    return null;
  }

  async function handleLogout() {
    await logout();
    router.push("/login");
  }

  return (
    <div className="min-h-screen">
      <SiteHeader onLogout={handleLogout} />
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-xl font-semibold tracking-tight text-text">
          Dashboard
        </h1>
        <div className="grid gap-4 sm:grid-cols-3">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              <Card className="h-full transition-colors hover:border-ember/50">
                <h2 className="font-medium text-text">{link.title}</h2>
                <p className="mt-1 text-sm text-subtext-1">
                  {link.description}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
