import type { DatabaseSync } from "node:sqlite";

export const REGISTRY_SCHEMA_VERSION = 1;

const INITIAL_SCHEMA = `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    session_file TEXT NOT NULL UNIQUE,
    file_materialized INTEGER NOT NULL CHECK (file_materialized IN (0,1)),
    cwd TEXT NOT NULL,
    name TEXT,
    runtime_state TEXT NOT NULL CHECK (runtime_state IN ('awake','asleep')),
    last_phase TEXT NOT NULL CHECK (last_phase IN ('idle','working','blocked','failed','gone')),
    attention TEXT NOT NULL CHECK (attention IN ('none','question','failed','interrupted')),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    epoch INTEGER NOT NULL CHECK (epoch >= 0),
    active_leaf_id TEXT,
    clean_shutdown INTEGER NOT NULL CHECK (clean_shutdown IN (0,1)),
    sleep_after_ms INTEGER,
    sleep_deadline_ms INTEGER,
    activity_token INTEGER NOT NULL CHECK (activity_token >= 0),
    last_activity_ms INTEGER NOT NULL,
    failure_code TEXT,
    failure_message TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );

  CREATE TABLE leases (
    session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
    lease_id TEXT NOT NULL UNIQUE,
    attachment_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    ttl_ms INTEGER NOT NULL
  );

  CREATE TABLE prompt_index (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    prompt_id TEXT NOT NULL UNIQUE,
    claim_entry_id TEXT NOT NULL UNIQUE,
    outcome_entry_id TEXT UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('pending','settled','aborted','failed')),
    final_entry_id TEXT,
    error_code TEXT,
    accepted_at_ms INTEGER NOT NULL,
    settled_at_ms INTEGER,
    PRIMARY KEY (session_id, key_hash)
  );
`;

function readUserVersion(database: DatabaseSync): number {
  const value = database.prepare("PRAGMA user_version").get()?.user_version;
  if (typeof value !== "number") {
    throw new Error("node:sqlite returned an invalid registry schema version");
  }
  return value;
}

export function migrateRegistry(database: DatabaseSync): void {
  const currentVersion = readUserVersion(database);
  if (currentVersion > REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `cannot open newer registry schema ${currentVersion}; supported version is ${REGISTRY_SCHEMA_VERSION}`,
    );
  }
  if (currentVersion === REGISTRY_SCHEMA_VERSION) {
    return;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    if (currentVersion === 0) {
      database.exec(INITIAL_SCHEMA);
      database.exec(`PRAGMA user_version = ${REGISTRY_SCHEMA_VERSION}`);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
