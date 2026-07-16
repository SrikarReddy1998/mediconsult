/**
 * Wire-up check for the ponytail MCP connector: spawn it over stdio (exactly as
 * .mcp.json does), complete the MCP handshake, and list its tool/prompt + call
 * the tool. Run: npx tsx scripts/probePonytail.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null) env[k] = v;
  env.PONYTAIL_DEFAULT_MODE = "full";

  const transport = new StdioClientTransport({
    command: process.execPath, // the running node.exe
    args: ["vendor/ponytail/ponytail-mcp/index.js"],
    env,
  });
  const client = new Client({ name: "ponytail-probe", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const prompts = await client.listPrompts().catch(() => ({ prompts: [] as { name: string }[] }));
  console.log("tools:  ", tools.tools.map((t) => t.name).join(", ") || "(none)");
  console.log("prompts:", prompts.prompts.map((p) => p.name).join(", ") || "(none)");

  const res = (await client.callTool({ name: "ponytail_instructions", arguments: {} })) as { content?: { type: string; text?: string }[] };
  const sample = (res.content?.find((c) => c.type === "text")?.text ?? "").slice(0, 120).replace(/\n/g, " ");
  console.log("ponytail_instructions →", sample ? `"${sample}..."` : "(no text)");

  await client.close();
  console.log("\nPONYTAIL WIRED UP OK");
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
