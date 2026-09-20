const REACHABILITY_TIMEOUT_MS = 3000;

export interface DecisionMakerStatus {
  id: "random" | "typesafe" | "openrouter";
  label: string;
  configured: boolean;
  reachable: boolean;
}

// Confirms the host answers at all — not that a real Jev decision
// succeeds, which would spend a real request against a paid API. Any
// response (even a 4xx from hitting the bare base URL) means the
// network path to the provider is up; a thrown error means it isn't.
async function isReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
  try {
    await fetch(url, { method: "GET", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getDecisionMakerStatuses(): Promise<
  DecisionMakerStatus[]
> {
  const typesafeKey = process.env.TYPESAFE_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  const typesafeBaseUrl =
    process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai";
  const openrouterBaseUrl =
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/alpha";

  const [typesafeReachable, openrouterReachable] = await Promise.all([
    typesafeKey ? isReachable(typesafeBaseUrl) : Promise.resolve(false),
    openrouterKey ? isReachable(openrouterBaseUrl) : Promise.resolve(false),
  ]);

  return [
    {
      id: "random",
      label: "Random Decision Maker",
      configured: true,
      reachable: true,
    },
    {
      id: "typesafe",
      label: "TypeSafe Jev Decision Maker",
      configured: Boolean(typesafeKey),
      reachable: Boolean(typesafeKey) && typesafeReachable,
    },
    {
      id: "openrouter",
      label: "OpenRouter Jev Decision Maker",
      configured: Boolean(openrouterKey),
      reachable: Boolean(openrouterKey) && openrouterReachable,
    },
  ];
}
