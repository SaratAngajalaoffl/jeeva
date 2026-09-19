"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { checkSession, logout } from "@/lib/api";

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
    <main className="flex min-h-screen flex-col gap-4 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <button onClick={handleLogout} className="rounded border px-3 py-1">
          Log out
        </button>
      </div>
      <Link href="/dashboard/markets" className="underline">
        Markets
      </Link>
      <Link href="/dashboard/wallet" className="underline">
        Mock wallet
      </Link>
      <Link href="/dashboard/decisions" className="underline">
        Positions &amp; decisions
      </Link>
    </main>
  );
}
