/**
 * MediConsult AI (TS) — LLM-based full document extraction.
 *
 * Uses the resilient router (Ollama fallback always available) to extract ALL
 * medical data from document text in one pass: medications, diagnoses, and lab
 * results (supplementing the regex extractor). Degrades gracefully: on any LLM
 * or JSON failure, returns empty lists so the caller falls back to regex only.
 * Mirrors extract_full.py.
 */
import { router } from "../agents/llmRouter.js";

const SYSTEM_PROMPT = `You are a medical document parser. Extract ALL medical data
from the document text the user provides. Reply ONLY with valid JSON — no prose,
no markdown fences, no commentary. If a field is absent, use null or [].

Return this exact structure:
{
  "document_type": "<lab_report|discharge_summary|prescription|clinical_note|other>",
  "document_date": "<YYYY-MM-DD or null>",
  "lab_name": "<lab or hospital name or null>",
  "doctor": "<doctor name or null>",
  "medications": [
    {"drug_name":"<generic>","brand_name":"<brand or null>","dose":"<e.g. 500mg>","frequency":"<e.g. twice daily>","route":"<oral|IV|SC|topical|inhaled|other>","indication":"<reason or null>","start_date":"<YYYY-MM-DD or null>","notes":"<extra or null>"}
  ],
  "diagnoses": [
    {"name":"<full diagnosis name>","icd10":"<code or null>","date":"<YYYY-MM-DD or null>","status":"<active|resolved|remission|suspected>","notes":"<null>"}
  ],
  "lab_results": [
    {"test":"<test name>","value":<numeric or null>,"text_value":"<text if not numeric else null>","unit":"<unit or null>","ref_low":<lower or null>,"ref_high":<upper or null>,"flag":"<H|L|HH|LL|null>"}
  ]
}`;

export interface LlmExtraction {
  document_type: string;
  document_date: string | null;
  lab_name: string | null;
  doctor: string | null;
  medications: Record<string, any>[];
  diagnoses: Record<string, any>[];
  lab_results: Record<string, any>[];
}

function empty(): LlmExtraction {
  return { document_type: "unknown", document_date: null, lab_name: null, doctor: null, medications: [], diagnoses: [], lab_results: [] };
}

export async function extractAll(text: string): Promise<LlmExtraction> {
  if (!text || !text.trim()) return empty();
  const snippet = text.slice(0, 6000); // keep within model context

  let raw: string;
  try {
    const result = await router.complete(SYSTEM_PROMPT, `Extract all medical data from this document:\n\n${snippet}`, undefined, 60_000);
    raw = result.text;
  } catch (e) {
    console.error(`[extractFull] LLM call failed: ${String((e as Error)?.message ?? e)}`);
    return empty();
  }

  // Strip markdown fences if the model added them despite instructions.
  raw = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}") + 1;
  if (start === -1 || end === 0) {
    console.error("[extractFull] No JSON object found in LLM output");
    return empty();
  }

  let data: Record<string, any>;
  try {
    data = JSON.parse(raw.slice(start, end));
  } catch (e) {
    console.error(`[extractFull] JSON parse error: ${String((e as Error)?.message ?? e)}`);
    return empty();
  }

  for (const k of ["medications", "diagnoses", "lab_results"] as const) {
    if (!Array.isArray(data[k])) data[k] = [];
  }
  return { ...empty(), ...data } as LlmExtraction;
}
