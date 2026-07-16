/**
 * MediConsult AI (TS) — local MCP server (stdio).
 *
 * The front-end: you talk to Claude; Claude calls these tools to reach into the
 * patient record. Tool logic lives in tools.ts (shared with the remote server).
 * Locally, security is the OS + Tailscale, so the guard only audit-logs.
 *
 * Do not log to stdout — stdio is the MCP transport.
 * Run:  npm start
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadEnv } from "../config.js";
loadEnv();

import { registerServer } from "./tools.js";
import { audit } from "./auth.js";

const server = new McpServer({ name: "MediConsult", version: "1.0.0" });

// Local: no role scoping (OS + Tailscale are the boundary) — just audit-log.
registerServer(server, { guard: (name, args) => audit(name, "local", true, args) });

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("MediConsult MCP server failed:", e);
  process.exit(1);
});
