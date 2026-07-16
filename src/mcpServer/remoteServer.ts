/**
 * MediConsult AI (TS) — REMOTE MCP server (network-reachable, Streamable HTTP).
 *
 * The variant Claude on a phone / claude.ai / a remote Claude Code connects to.
 * Difference from the local server:
 *   - transport = Streamable HTTP (POST/GET/DELETE /mcp) instead of stdio
 *   - bearer-token auth + role scoping on every request (fail-closed on anon)
 *   - intended to run behind Cloudflare Tunnel + Access, or Tailscale
 *
 * Same tool LOGIC as the local server (imported from tools.ts) — the guard is
 * the only difference: here it audit-logs AND enforces the caller's role.
 *
 * Run:  MEDICONSULT_AUTH_SECRET=... npm run start:remote
 * Mint tokens:  npm run token owner
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { loadEnv } from "../config.js";
loadEnv();

import { registerServer } from "./tools.js";
import { canCall, verifyToken, audit } from "./auth.js";

const PORT = Number(process.env.MEDICONSULT_REMOTE_PORT ?? 8765);

class PermissionError extends Error {}

/** One session = one bearer = one role. Transport + bound role, keyed by session id. */
interface Session {
  transport: StreamableHTTPServerTransport;
  role: string;
}
const sessions = new Map<string, Session>();

function buildServer(role: string): McpServer {
  const server = new McpServer({ name: "MediConsult-Remote", version: "1.0.0" });
  registerServer(server, {
    guard: (name, args) => {
      const allowed = canCall(role, name);
      audit(name, role, allowed, args);
      if (!allowed) throw new PermissionError(`Role '${role}' is not permitted to call '${name}'.`);
    },
  });
  return server;
}

function roleFromAuth(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string" || !h.toLowerCase().startsWith("bearer ")) return null;
  const payload = verifyToken(h.slice(7).trim());
  return payload ? payload.role : null;
}

function readBody(req: IncomingMessage, cap = 25 * 1024 * 1024): Promise<string> {
  // Cap the body (JSON-RPC messages are small) so an authenticated client can't
  // OOM the server; accumulate as buffers to avoid V8's ~512 MB string-concat
  // RangeError (which would otherwise hang the request).
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > cap) {
        req.destroy();
        reject(new Error(`request body exceeds ${Math.floor(cap / 1024 / 1024)} MB limit`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: id ?? null };
}

const httpServer = createHttpServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];

  // Liveness probe (no auth) — for Cloudflare/Tailscale health checks.
  if (req.method === "GET" && url === "/health") return sendJson(res, 200, { status: "ok" });

  if (url !== "/mcp") return sendJson(res, 404, { error: "not found" });

  // Auth on EVERY request — refuse anonymous (fail-closed).
  const role = roleFromAuth(req);
  if (!role) {
    audit("connect", "anonymous", false, {});
    return sendJson(res, 401, rpcError(null, -32001, "Unauthenticated. A valid Bearer token is required — this server handles medical data and refuses anonymous access."));
  }

  const sessionId = req.headers["mcp-session-id"];
  const sid = typeof sessionId === "string" ? sessionId : undefined;

  try {
    // Existing session → route to it (role must match the session's bound role).
    if (sid) {
      const session = sessions.get(sid);
      if (!session) return sendJson(res, 404, rpcError(null, -32000, "Unknown or expired session."));
      if (session.role !== role) return sendJson(res, 403, rpcError(null, -32003, "Token role does not match this session."));
      if (req.method === "POST") {
        const raw = await readBody(req);
        await session.transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
      } else {
        // GET (SSE stream) / DELETE (terminate)
        await session.transport.handleRequest(req, res);
      }
      return;
    }

    // No session id → must be an initialize POST.
    if (req.method !== "POST") return sendJson(res, 405, rpcError(null, -32000, "Method not allowed without a session (use POST to initialize)."));
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : undefined;
    if (!isInitializeRequest(body)) return sendJson(res, 400, rpcError((body as { id?: unknown })?.id, -32600, "Expected an initialize request to open a session."));

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true, // single JSON response per POST (no SSE needed for our tools)
      onsessioninitialized: (newId) => {
        sessions.set(newId, { transport, role });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = buildServer(role);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 400, rpcError(null, -32700, `Bad request: ${String((e as Error)?.message ?? e)}`));
  }
});

function main(): void {
  if (!process.env.MEDICONSULT_AUTH_SECRET) {
    console.error("ERROR: MEDICONSULT_AUTH_SECRET not set. Mint a token with `npm run token owner` after setting it.");
    process.exit(1);
  }
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.error(`MediConsult REMOTE MCP server on http://0.0.0.0:${PORT}/mcp (Streamable HTTP).`);
    console.error("Put it behind Tailscale or Cloudflare Tunnel. Every call is bearer-authed, role-scoped, and audit-logged.");
  });
}

main();
