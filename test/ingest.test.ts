/**
 * MediConsult AI (TS) — ingestion tests.
 *
 * The regex extractor (fix #2) is pure. The pipeline end-to-end is exercised on
 * a TEXT file so no OCR/Ollama is needed — the LLM extraction degrades to empty
 * gracefully, and the regex path still routes correctly.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(() => {
  process.env.MEDICONSULT_DATA = mkdtempSync(join(tmpdir(), "medi-ingest-"));
});

import { extractLabValues } from "../src/ingest/extract.js";
import { initDb } from "../src/db/schema.js";
import { processFile } from "../src/ingest/pipeline.js";
import type { LlmExtraction } from "../src/ingest/extractFull.js";

// No-op LLM extractor so the pipeline test is fast + Ollama-independent.
const noLlm = async (): Promise<LlmExtraction> => ({ document_type: "unknown", document_date: null, lab_name: null, doctor: null, medications: [], diagnoses: [], lab_results: [] });

describe("regex lab extraction (fix #2)", () => {
  it("surfaces an out-of-bounds value at low confidence (not dropped)", () => {
    const vals = extractLabValues("Potassium 15 (3.5-5.1)");
    expect(vals.length).toBe(1);
    expect(vals[0].canonical).toBe("potassium");
    expect(vals[0].value).toBe(15);
    expect(vals[0].extractionConfidence).toBeLessThanOrEqual(0.2);
  });

  it("keeps a normal value at high confidence", () => {
    const vals = extractLabValues("Potassium 4.1 mmol/L (3.5-5.1)");
    expect(vals[0].value).toBe(4.1);
    expect(vals[0].extractionConfidence).toBeGreaterThanOrEqual(0.8);
  });
});

describe("pipeline end-to-end (text file; LLM extraction degrades gracefully)", () => {
  beforeEach(() => initDb());

  it("accepts a plausible lab from a text report → timeline", async () => {
    const f = join(process.env.MEDICONSULT_DATA!, "report.txt");
    await writeFile(f, "Complete Blood Count\nHaemoglobin 9.5 g/dL (12.0-16.0)\nPlatelets 250 (150-400)\n");
    const res = await processFile(f, { llmExtract: noLlm });
    expect(res.status).toBe("processed");
    expect(res.accepted.map((a: any) => a.test)).toContain("haemoglobin");
  });

  it("routes an out-of-bounds value to review + raises an unconfirmed-critical alert", async () => {
    const f = join(process.env.MEDICONSULT_DATA!, "k.txt");
    await writeFile(f, "Potassium 15 (3.5-5.1)\n");
    const res = await processFile(f, { llmExtract: noLlm });
    expect(res.review.some((r: any) => r.test === "potassium")).toBe(true);
    expect(res.alerts.length).toBeGreaterThanOrEqual(1); // is_critical(potassium,15) → urgent
  });
});
