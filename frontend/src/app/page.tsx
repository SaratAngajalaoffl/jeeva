import Link from "next/link";
import Logo from "@/components/Logo";

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center">
        <Logo height={48} />
        <p className="max-w-sm text-sm text-subtext-1">
          Jev-driven Hyperliquid perp trading dashboard.
        </p>
        <Link
          href="/login"
          className="mt-2 inline-flex items-center justify-center rounded-lg bg-ember px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-ember/90"
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}
