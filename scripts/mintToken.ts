/**
 * MediConsult AI (TS) — mint a signed bearer token for the remote server.
 *
 * Run:  MEDICONSULT_AUTH_SECRET=... npm run token owner
 *       npm run token clinician
 *       npm run token caretaker
 */
import { loadEnv } from "../src/config.js";
loadEnv();

import { issueToken, ROLE_SCOPES } from "../src/mcpServer/auth.js";

const role = process.argv[2] ?? "owner";
if (!(role in ROLE_SCOPES)) {
  console.error(`Unknown role '${role}'. Use one of: ${Object.keys(ROLE_SCOPES).join(", ")}`);
  process.exit(1);
}

try {
  console.log(`Token for role '${role}' (valid 30 days):\n`);
  console.log(issueToken(role));
  console.log("\nUse as the Bearer token in your MCP client (behind Cloudflare Access / Tailscale). Keep it secret.");
} catch (e) {
  console.error(String((e as Error)?.message ?? e));
  process.exit(1);
}
