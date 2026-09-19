"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/lib/api";
import { Button, Card, Input, Label } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
        </form>
      </Card>
    </main>
  );
}
