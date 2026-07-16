/**
 * MediConsult AI (TS) — one-shot bootstrap: database + placeholder patient.
 *
 * Run:  npm run bootstrap
 */
import { loadEnv } from "../src/config.js";
loadEnv();

import { initDb, getDbPath } from "../src/db/schema.js";
import { getPatient, upsertPatient } from "../src/db/access.js";

initDb();

if (!getPatient()) {
  upsertPatient({
    fullName: "Placeholder Patient",
    dateOfBirth: "1970-01-01",
    sex: "F",
    bloodGroup: "O+",
    uhid: "PLACEHOLDER",
    allergies: [],
  });
  console.log("Created placeholder patient — replace with the real record before any clinical use.");
} else {
  console.log("Patient record already present.");
}

console.log(`Database ready at ${getDbPath()}`);
