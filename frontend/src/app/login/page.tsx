"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchDemoMode, login } from "@/lib/api";
import Logo from "@/components/Logo";
import { Button, Card, Input, Label } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [demoMode, setDemoMode] = useState(false);

  useEffect(() => {
    fetchDemoMode().then(setDemoMode);
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await login(username, password);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.push("/dashboard");
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <Link
          href="/"
          aria-label="Jeeva home"
          className="mb-6 flex items-center justify-center"
        >
          <Logo height={22} />
        </Link>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <h1 className="text-xl font-semibold tracking-tight text-text">
            Sign in
          </h1>
          <label className="flex flex-col gap-1">
            <Label>Username</Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="flex flex-col gap-1">
            <Label>Password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={submitting}>
            {submitting ? "Signing in..." : "Sign in"}
          </Button>
          {demoMode && (
            <p className="text-center text-sm text-subtext-1">
              Demo credentials: <span className="font-medium">admin</span> /{" "}
              <span className="font-medium">password</span>
            </p>
          )}
        </form>
      </Card>
    </main>
  );
}
