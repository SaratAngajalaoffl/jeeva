function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getAuthConfig() {
  return {
    username: requireEnv("AUTH_USERNAME"),
    password: requireEnv("AUTH_PASSWORD"),
    jwtSecret: requireEnv("JWT_SECRET"),
  };
}

export const SESSION_COOKIE_NAME = "jeeva_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24h
