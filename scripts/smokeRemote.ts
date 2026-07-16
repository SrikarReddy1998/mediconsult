/**
 * Live smoke test for the remote server. Assumes it's running on SMOKE_URL
 * (default http://localhost:8765) with the SAME MEDICONSULT_AUTH_SECRET.
 * Checks: anon → 401, owner initialize + tools/list, caretaker role denial.
 */
import { loadEnv } from "../src/config.js";
loadEnv();
import { issueToken } from "../src/mcpServer/auth.js";

const BASE = process.env.SMOKE_URL ?? "http://localhost:8765";
const MCP = `${BASE}/mcp`;
const ACCEPT = "application/json, text/event-stream";

function jrpc(method: string, params?: unknown, id?: number): string {
  return JSON.stringify(id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params });
}

function headers(token?: string, sid?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", Accept: ACCEPT };
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (sid) h["mcp-session-id"] = sid;
  return h;
}

async function waitForHealth(tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not become healthy in time");
}

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
}

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } };

async function openSession(token: string): Promise<string> {
  const init = await fetch(MCP, { method: "POST", headers: headers(token), body: jrpc("initialize", INIT, 1) });
  const sid = init.headers.get("mcp-session-id") ?? "";
  await fetch(MCP, { method: "POST", headers: headers(token, sid), body: jrpc("notifications/initialized") });
  return sid;
}

async function main(): Promise<void> {
  await waitForHealth();
  check("health endpoint responds", true);

  // 1. anonymous → 401
  const anon = await fetch(MCP, { method: "POST", headers: headers(), body: jrpc("initialize", INIT, 1) });
  check("anonymous POST /mcp → 401", anon.status === 401, `got ${anon.status}`);

  // 2. owner initialize
  const owner = issueToken("owner");
  const init = await fetch(MCP, { method: "POST", headers: headers(owner), body: jrpc("initialize", INIT, 1) });
  const sid = init.headers.get("mcp-session-id") ?? "";
  const initBody = (await init.json().catch(() => ({}))) as { result?: { serverInfo?: { name?: string } } };
  check("owner initialize → 200", init.status === 200, `status ${init.status}`);
  check("session id returned", !!sid);
  check("initialize result has serverInfo", !!initBody?.result?.serverInfo, initBody?.result?.serverInfo?.name ?? "");
  await fetch(MCP, { method: "POST", headers: headers(owner, sid), body: jrpc("notifications/initialized") });

  // 3. tools/list
  const list = await fetch(MCP, { method: "POST", headers: headers(owner, sid), body: jrpc("tools/list", {}, 2) });
  const listBody = (await list.json().catch(() => ({}))) as { result?: { tools?: { name: string }[] } };
  const names = (listBody?.result?.tools ?? []).map((t) => t.name);
  check("tools/list returns tools", names.length > 0, `${names.length} tools`);
  check("has get_lab_trend + confirm_review", names.includes("get_lab_trend") && names.includes("confirm_review"));

  // 4. role scoping: caretaker denied get_lab_trend
  const caretaker = issueToken("caretaker");
  const csid = await openSession(caretaker);
  const call = await fetch(MCP, {
    method: "POST",
    headers: headers(caretaker, csid),
    body: jrpc("tools/call", { name: "get_lab_trend", arguments: { test_name: "haemoglobin" } }, 3),
  });
  const callText = JSON.stringify(await call.json().catch(() => ({})));
  check("caretaker denied get_lab_trend", /not permitted/i.test(callText), callText.slice(0, 140));

  console.log(`\n${failures === 0 ? "ALL SMOKE CHECKS PASSED" : failures + " SMOKE CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke error:", e);
  process.exit(1);
});
