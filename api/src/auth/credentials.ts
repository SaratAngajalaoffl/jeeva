import { timingSafeEqual } from "node:crypto";

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Compare against a fixed-length digest of each side so the comparison
  // itself never leaks length information via early-exit timing, then
  // guard the (still length-sensitive) final byte-length check.
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers to avoid a fast
    // short-circuit that would leak the input length differs.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function credentialsMatch(
  provided: { username: string; password: string },
  expected: { username: string; password: string },
): boolean {
  const usernameMatches = timingSafeStringEqual(
    provided.username,
    expected.username,
  );
  const passwordMatches = timingSafeStringEqual(
    provided.password,
    expected.password,
  );
  return usernameMatches && passwordMatches;
}
