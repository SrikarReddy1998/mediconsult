/**
 * MediConsult AI (TS) — set the REAL patient record (replaces the placeholder).
 *
 * Run (fill in your own details):
 *   npm run setup:patient -- --name "Full Name" --dob 1978-03-14 --sex F \
 *     --blood O+ --uhid ABC123 --tz Asia/Kolkata --allergies "penicillin, sulfa"
 *
 * Only --name, --dob, --sex are required. Everything stays local (writes to the
 * DB under MEDICONSULT_DATA); nothing is transmitted anywhere.
 */
import { loadEnv } from "../src/config.js";
loadEnv();
import { initDb } from "../src/db/schema.js";
import { getPatient, upsertPatient } from "../src/db/access.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const name = flag("name");
const dob = flag("dob");
const sex = flag("sex");

if (!name || !dob || !sex) {
  console.error(
    'Usage: npm run setup:patient -- --name "Full Name" --dob YYYY-MM-DD --sex M|F|Other ' +
    '[--blood O+] [--uhid ID] [--tz Asia/Kolkata] [--allergies "a, b"]',
  );
  process.exit(1);
}

const allergiesRaw = flag("allergies");

initDb();
upsertPatient({
  fullName: name,
  dateOfBirth: dob,
  sex,
  bloodGroup: flag("blood") ?? null,
  uhid: flag("uhid") ?? null,
  homeTimezone: flag("tz") ?? "Asia/Kolkata",
  allergies: allergiesRaw ? allergiesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
});

const p = getPatient();
console.log("Patient record set:");
console.log(`  ${p?.full_name}, DOB ${p?.date_of_birth}, ${p?.sex}, blood ${p?.blood_group ?? "n/a"}, UHID ${p?.uhid ?? "n/a"}`);
console.log(`  timezone ${p?.home_timezone}, allergies ${p?.known_allergies}`);
