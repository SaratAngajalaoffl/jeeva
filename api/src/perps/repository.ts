import type { Collection, Db } from "mongodb";
import { applyToggleRules, type PerpToggles } from "./toggleRules.js";

export interface PerpFrequencies {
  decisionFrequencySeconds: number;
  samplingFrequencySeconds: number;
}

export interface PerpSizing {
  leverage: number;
  positionSizeUsd: number;
}

// The engine's DecisionMaker implementation for this PERP: `fake`
// (synthetic, no network), `typesafe` (calls TypeSafe's Jev API
// directly), or `openrouter` (calls Jev via OpenRouter — not yet
// implemented on the engine side, see GH issue).
export type DecisionMaker = "fake" | "typesafe" | "openrouter";

export interface PerpDecisionMaker {
  decisionMaker: DecisionMaker;
}

export interface PerpWallet {
  walletId: string | null;
}

export interface PerpConfigDoc
  extends PerpToggles, PerpFrequencies, PerpSizing, PerpDecisionMaker, PerpWallet {
  symbol: string;
}

export type PerpConfigPatch = Partial<
  PerpToggles & PerpFrequencies & PerpSizing & PerpDecisionMaker & PerpWallet
>;

export const DEFAULT_PERP_CONFIG: PerpToggles &
  PerpFrequencies &
  PerpSizing &
  PerpDecisionMaker &
  PerpWallet = {
  tradingEnabled: false,
  samplingEnabled: false,
  decisionFrequencySeconds: 300,
  samplingFrequencySeconds: 60,
  leverage: 1,
  positionSizeUsd: 100,
  decisionMaker: "fake",
  walletId: null,
};

const COLLECTION_NAME = "perpConfigs";

function collection(db: Db): Collection<PerpConfigDoc> {
  return db.collection<PerpConfigDoc>(COLLECTION_NAME);
}

export async function getAllConfigs(db: Db): Promise<PerpConfigDoc[]> {
  return collection(db)
    .find({}, { projection: { _id: 0 } })
    .toArray();
}

export async function getConfig(
  db: Db,
  symbol: string,
): Promise<PerpConfigDoc | null> {
  return collection(db).findOne({ symbol }, { projection: { _id: 0 } });
}

export async function updatePerpConfig(
  db: Db,
  symbol: string,
  patch: PerpConfigPatch,
): Promise<PerpConfigDoc> {
  const existing = await getConfig(db, symbol);
  const current: PerpConfigDoc = existing ?? {
    symbol,
    ...DEFAULT_PERP_CONFIG,
  };

  const toggles = applyToggleRules(current, {
    tradingEnabled: patch.tradingEnabled,
    samplingEnabled: patch.samplingEnabled,
  });

  const next: PerpConfigDoc = {
    symbol,
    ...toggles,
    decisionFrequencySeconds:
      patch.decisionFrequencySeconds ?? current.decisionFrequencySeconds,
    samplingFrequencySeconds:
      patch.samplingFrequencySeconds ?? current.samplingFrequencySeconds,
    leverage: patch.leverage ?? current.leverage,
    positionSizeUsd: patch.positionSizeUsd ?? current.positionSizeUsd,
    decisionMaker: patch.decisionMaker ?? current.decisionMaker,
    walletId:
      patch.walletId !== undefined ? patch.walletId : current.walletId,
  };

  await collection(db).updateOne({ symbol }, { $set: next }, { upsert: true });

  return next;
}
