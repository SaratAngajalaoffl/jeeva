export interface PerpMeta {
  symbol: string;
}

export interface HyperliquidClient {
  listPerps(): Promise<PerpMeta[]>;
}

interface MetaResponse {
  universe: { name: string }[];
}

export function createHyperliquidClient(
  baseUrl = "https://api.hyperliquid.xyz",
): HyperliquidClient {
  return {
    async listPerps(): Promise<PerpMeta[]> {
      const res = await fetch(`${baseUrl}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "meta" }),
      });

      if (!res.ok) {
        throw new Error(`Hyperliquid meta request failed: ${res.status}`);
      }

      const body = (await res.json()) as MetaResponse;
      return body.universe.map((entry) => ({ symbol: entry.name }));
    },
  };
}
