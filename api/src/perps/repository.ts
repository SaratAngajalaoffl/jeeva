import type { Collection, Db } from "mongodb";
import { applyToggleRules, type PerpToggles } from "./toggleRules.js";

export interface PerpFrequencies {
  decisionFrequencySeconds: number;
  samplingFrequencySeconds: number;
}

export interface PerpConfigDoc extends PerpToggles, PerpFrequencies {
  symbol: string;
}

export type PerpConfigPatch = Partial<PerpToggles & PerpFrequencies>;

export const DEFAULT_PERP_CONFIG: PerpToggles & PerpFrequencies = {
  tradingEnabled: false,
  samplingEnabled: false,
  decisionFrequencySeconds: 300,
  samplingFrequencySeconds: 60,
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
  };

  await collection(db).updateOne({ symbol }, { $set: next }, { upsert: true });

  return next;
}
