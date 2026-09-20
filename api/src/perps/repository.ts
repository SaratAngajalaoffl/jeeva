import type { Collection, Db } from "mongodb";

export interface PerpMarketSettings {
  samplingEnabled: boolean;
  samplingFrequencySeconds: number;
}

export interface PerpConfigDoc extends PerpMarketSettings {
  symbol: string;
}

export type PerpConfigPatch = Partial<PerpMarketSettings>;

export const DEFAULT_PERP_CONFIG: PerpMarketSettings = {
  samplingEnabled: false,
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

  const next: PerpConfigDoc = {
    symbol,
    samplingEnabled: patch.samplingEnabled ?? current.samplingEnabled,
    samplingFrequencySeconds:
      patch.samplingFrequencySeconds ?? current.samplingFrequencySeconds,
  };

  await collection(db).updateOne({ symbol }, { $set: next }, { upsert: true });

  return next;
}
