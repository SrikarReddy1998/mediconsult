/**
 * Wire-up check for the hermes MCP connector: spawn `hermes mcp serve` over
 * stdio, complete the MCP handshake, and list its tools.
 * Usage: HERMES_BIN=/path/to/hermes npx tsx scripts/probeHermes.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main(): Promise<void> {
  const bin = process.env.HERMES_BIN || "hermes";
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null) env[k] = v;

  const transport = new StdioClientTransport({ command: bin, args: ["mcp", "serve"], env });
  const client = new Client({ name: "hermes-probe", version: "1.0.0" });

  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`tools (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(", ") || "(none)");
  await client.close();
  console.log("\nHERMES mcp serve WIRED UP OK");
}

main().catch((e) => {
  console.error("hermes probe failed:", String((e as Error)?.message ?? e));
  process.exit(1);
});
