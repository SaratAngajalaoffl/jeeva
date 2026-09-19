const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function login(
  username: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    return { ok: false, error: "Invalid username or password" };
  }
  return { ok: true };
}

export async function logout(): Promise<void> {
  await fetch(`${API_URL}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

export async function checkSession(): Promise<boolean> {
  const res = await fetch(`${API_URL}/auth/session`, {
    credentials: "include",
  });
  return res.ok;
}
