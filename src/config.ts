/**
 * MediConsult AI (TS) — environment + paths.
 *
 * Loads .env once (idempotent) and resolves the data directory. Mirrors the
 * Python config.load_env() so the LLM router and DB read the same env names.
 */
import { config as dotenvConfig } from "dotenv";
import { homedir } from "node:os";
import { join } from "node:path";

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  dotenvConfig(); // loads <cwd>/.env if present
  loaded = true;
}

/** Where the patient record + database + logs live. */
export function dataDir(): string {
  return process.env.MEDICONSULT_DATA ?? join(homedir(), "patient_data");
}
