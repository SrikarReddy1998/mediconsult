/**
 * MediConsult AI (TS) — index the seed guideline + drug knowledge into RAG.
 *
 * Run once after setup, and again whenever knowledgeSeed.ts changes:
 *   npm run load:knowledge
 * Requires Ollama running with the embedding model pulled:
 *   ollama pull nomic-embed-text
 */
import { loadEnv } from "../src/config.js";
loadEnv();

import { rag } from "../src/rag/store.js";
import { allEntries } from "../src/rag/knowledgeSeed.js";

async function main(): Promise<void> {
  const entries = allEntries();
  for (const e of entries) {
    const text = `${e.title}\n\n${e.body}`;
    await rag.addGuideline(e.id, text, {
      title: e.title,
      topic: e.topic,
      source: e.source,
      kind: e.kind,
      last_reviewed: e.last_reviewed,
    });
  }
  console.log(`Indexed ${entries.length} knowledge entries into 'guidelines'.`);

  const hits = await rag.searchGuidelines("febrile neutropenia antibiotics", 2);
  console.log("\nSmoke test — search 'febrile neutropenia antibiotics':");
  for (const h of hits) console.log(`  • ${h.metadata.title} (dist=${h.distance?.toFixed?.(3)})`);
}

main().catch((e) => {
  console.error(String((e as Error)?.message ?? e));
  process.exit(1);
});
