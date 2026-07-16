// Plain-JS wire-up check for the hermes MCP connector (no tsx/esbuild), run under
// WSL Linux node so it can spawn the Linux `hermes` binary.
// Usage: HERMES_BIN=/path/to/hermes node scripts/probeHermes.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bin = process.env.HERMES_BIN || "hermes";
const transport = new StdioClientTransport({ command: bin, args: ["mcp", "serve"], env: process.env });
const client = new Client({ name: "hermes-probe", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`tools (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(", ") || "(none)");
  await client.close();
  console.log("\nHERMES mcp serve WIRED UP OK");
} catch (e) {
  console.error("hermes probe failed:", String(e?.message ?? e));
  process.exit(1);
}
