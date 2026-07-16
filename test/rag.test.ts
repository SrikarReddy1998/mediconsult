/**
 * MediConsult AI (TS) — RAG store tests.
 *
 * Exercises the real sqlite-vec vector store (load + vec0 KNN + upsert +
 * collection isolation) with a DETERMINISTIC injected embedder, so it runs
 * without Ollama. Ollama end-to-end is covered by `npm run load:knowledge`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fresh rag.db per test (isolation) — dataDir() reads this at connection time.
beforeEach(() => {
  process.env.MEDICONSULT_DATA = mkdtempSync(join(tmpdir(), "medi-rag-"));
});

import { RagStore } from "../src/rag/store.js";

// 8-dim char-frequency vector — identical text → identical vector → distance 0.
function fakeEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((t) => {
      const v = new Array(8).fill(0);
      for (const ch of t.toLowerCase()) v[ch.charCodeAt(0) % 8] += 1;
      return v;
    }),
  );
}

describe("RAG store (sqlite-vec + injected embedder)", () => {
  it("indexes and retrieves the nearest guideline", async () => {
    const store = new RagStore(fakeEmbed);
    await store.addGuideline("g1", "sepsis septic shock norepinephrine antibiotics", { title: "Sepsis" });
    await store.addGuideline("g2", "platelet transfusion threshold bleeding", { title: "Platelets" });
    const hits = await store.searchGuidelines("sepsis septic shock norepinephrine antibiotics", 1);
    expect(hits.length).toBe(1);
    expect(hits[0].metadata.title).toBe("Sepsis");
    expect(hits[0].distance).toBeLessThan(0.001); // exact text → ~0 distance
  });

  it("upserts in place (no duplicate) on re-add of the same doc_id", async () => {
    const store = new RagStore(fakeEmbed);
    await store.addGuideline("g1", "first version alpha", { title: "V1" });
    await store.addGuideline("g1", "second version beta", { title: "V2" });
    const hits = await store.searchGuidelines("second version beta", 5);
    expect(hits.filter((h) => h.metadata.title === "V2").length).toBe(1);
    expect(hits.some((h) => h.metadata.title === "V1")).toBe(false);
  });

  it("keeps guidelines and history collections separate", async () => {
    const store = new RagStore(fakeEmbed);
    await store.addGuideline("g1", "guideline content xyz", { title: "G" });
    await store.addHistoryChunk("h1", "history content xyz", { title: "H" });
    expect((await store.searchGuidelines("xyz", 5)).every((x) => x.metadata.title === "G")).toBe(true);
    expect((await store.searchHistory("xyz", 5)).every((x) => x.metadata.title === "H")).toBe(true);
  });

  it("returns [] when nothing is indexed", async () => {
    const store = new RagStore(fakeEmbed);
    expect(await store.searchHistory("anything")).toEqual([]);
  });
});
