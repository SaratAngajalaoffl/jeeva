import type { Collection, Db } from "mongodb";

export type EngineMode = "mock" | "live";

interface EngineModeDoc {
  _id: "singleton";
  mode: EngineMode;
}

const COLLECTION_NAME = "engineConfig";
const SINGLETON_ID = "singleton" as const;

function collection(db: Db): Collection<EngineModeDoc> {
  return db.collection<EngineModeDoc>(COLLECTION_NAME);
}

/**
 * The engine-wide mode switch (mock/live), watched by the engine via a
 * MongoDB change stream (see engine/src/mode.rs) so a write here takes
 * effect immediately, engine-wide, with no restart and no per-PERP
 * override.
 */
export async function getEngineMode(db: Db): Promise<EngineMode> {
  const doc = await collection(db).findOne({ _id: SINGLETON_ID });
  return doc?.mode ?? "mock";
}

export async function setEngineMode(
  db: Db,
  mode: EngineMode,
): Promise<EngineMode> {
  await collection(db).updateOne(
    { _id: SINGLETON_ID },
    { $set: { mode } },
    { upsert: true },
  );
  return mode;
}
