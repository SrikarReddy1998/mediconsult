/**
 * MediConsult AI (TS) — auth for the REMOTE (network-reachable) MCP server.
 *
 * Local (stdio) relies on the OS + Tailscale. Remote is reachable over the
 * network, so it authenticates and authorises every request (June 2025 MCP
 * healthcare posture). Defence in depth: a network gate (Cloudflare Access /
 * Tunnel) in front, plus this app-layer signed bearer token + role scoping.
 *
 * Mirrors the Python auth.py.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.js";
import { nowUtc } from "../db/clinicalUtils.js";

export interface TokenPayload {
  role: string;
  exp: number;
}

// Tools/resources/prompts each role may call. "*" = everything. Anything not
// listed is denied. Owner-only action tools (confirm_review) are simply absent
// from clinician/caretaker scopes.
export const ROLE_SCOPES: Record<string, Set<string>> = {
  owner: new Set(["*"]),
  clinician: new Set([
    "get_lab_trend",
    "get_active_medications",
    "get_recent_timeline",
    "check_lab_value_safety",
    "get_critical_alerts",
    "get_pending_reviews",
    "run_specialist_review",
    "run_full_mdt_consultation",
    "llm_health",
    "search_patient_history",
    "verify_against_guideline",
    "check_drug_availability_india",
    "resource:patient_summary",
    "resource:active_medications",
    "resource:active_diagnoses",
    "prompt:specialist_assessment",
  ]),
  caretaker: new Set(["get_recent_timeline", "get_critical_alerts"]),
};

function secret(): Buffer {
  const s = process.env.MEDICONSULT_AUTH_SECRET;
  if (!s) {
    throw new Error(
      'MEDICONSULT_AUTH_SECRET not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
    );
  }
  return Buffer.from(s);
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("hex").slice(0, 32);
}

/** Issue a signed token for a role. Run once per device/person. */
export function issueToken(role: string, validDays = 30): string {
  if (!(role in ROLE_SCOPES)) throw new Error(`Unknown role '${role}'. Use: ${Object.keys(ROLE_SCOPES).join(", ")}`);
  const payload: TokenPayload = { role, exp: Math.floor(Date.now() / 1000) + validDays * 86400 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Verify a token. Returns the payload or null if invalid/expired/tampered. */
export function verifyToken(token: string): TokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    const expected = sign(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
    if ((payload.exp ?? 0) < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Is this role allowed to call this tool/resource/prompt? */
export function canCall(role: string, name: string): boolean {
  const scopes = ROLE_SCOPES[role];
  if (!scopes) return false;
  return scopes.has("*") || scopes.has(name);
}

/** Log every access decision. Required for a PHI-handling MCP server. */
export function audit(name: string, role: string, allowed: boolean, args: Record<string, unknown>): void {
  try {
    appendFileSync(join(dataDir(), "mcp_audit.log"), JSON.stringify({ time: nowUtc(), tool: name, role, allowed, args }) + "\n");
  } catch {
    /* never let an audit failure break a call */
  }
}
