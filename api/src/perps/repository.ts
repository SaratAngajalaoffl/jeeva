import type { Collection, Db } from "mongodb";
import { applyToggleRules, type PerpToggles } from "./toggleRules.js";

export interface PerpConfigDoc extends PerpToggles {
  symbol: string;
}

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

export async function updateToggles(
  db: Db,
  symbol: string,
  patch: Partial<PerpToggles>,
): Promise<PerpConfigDoc> {
  const existing = await getConfig(db, symbol);
  const current: PerpToggles = existing ?? {
    tradingEnabled: false,
    samplingEnabled: false,
  };
  const next = applyToggleRules(current, patch);
  const doc: PerpConfigDoc = { symbol, ...next };

  await collection(db).updateOne({ symbol }, { $set: doc }, { upsert: true });

  return doc;
}
