/**
 * Live smoke for the caretaker upload page. Assumes it's running on SMOKE_URL
 * (default http://localhost:8766) with the SAME MEDICONSULT_AUTH_SECRET + DATA.
 */
import { loadEnv, dataDir } from "../src/config.js";
loadEnv();
import { issueToken } from "../src/mcpServer/auth.js";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.SMOKE_URL ?? "http://localhost:8766";

async function waitForHealth(tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("upload server did not become healthy");
}

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

async function main(): Promise<void> {
  await waitForHealth();
  check("health endpoint responds", true);

  // anonymous upload → 401
  const anon = await fetch(`${BASE}/upload`, { method: "POST", body: "x" });
  check("anonymous upload → 401", anon.status === 401, `got ${anon.status}`);

  // caretaker upload → 200 + file lands in incoming/
  const token = issueToken("caretaker");
  const res = await fetch(`${BASE}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
      "x-filename": encodeURIComponent("note.txt"),
      "x-caption": encodeURIComponent("mum's arm looks swollen"),
      "x-captured-at": encodeURIComponent(new Date().toISOString()),
    },
    body: "Potassium 4.1 (3.5-5.1)",
  });
  const body = (await res.json().catch(() => ({}))) as { stored_as?: string };
  check("caretaker upload → 200", res.status === 200, `status ${res.status}`);
  check("server reports stored_as", !!body.stored_as, body.stored_as ?? "");

  const files = readdirSync(join(dataDir(), "incoming"));
  check("file + sidecar landed in incoming/", files.some((f) => f.endsWith("note.txt")) && files.some((f) => f.endsWith(".meta.json")), files.join(", "));

  console.log(`\n${failures === 0 ? "ALL SMOKE CHECKS PASSED" : failures + " SMOKE CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke error:", e);
  process.exit(1);
});
