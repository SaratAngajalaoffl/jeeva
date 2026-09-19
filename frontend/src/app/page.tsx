import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center">
        <span className="inline-block h-2 w-2 rounded-full bg-ember shadow-[0_0_12px_theme(colors.ember)]" />
        <h1 className="text-4xl font-semibold tracking-tight text-text">
          Jeeva
        </h1>
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
