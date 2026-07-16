/**
 * MediConsult AI (TS) — shared MCP surface (resources + tools + prompt).
 *
 * ONE source of tool logic, used by BOTH the local (stdio) and remote (HTTP)
 * servers. Each handler calls ctx.guard(name, args) first — for local that just
 * audit-logs; for remote it audit-logs AND enforces role scoping (throws to deny).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import * as db from "../db/access.js";
import { normaliseTestName } from "../db/referenceData.js";
import { scorePlausibility, isCritical } from "../db/clinicalUtils.js";
import { router } from "../agents/llmRouter.js";
import { getAgentPrompt } from "../agents/prompts.js";
import { rag } from "../rag/store.js";
import { runConsultation, DEFAULT_ROSTER } from "../agents/council.js";
import { processFile, processIncomingFolder } from "../ingest/pipeline.js";

export interface ToolContext {
  /** Audit + authorize. Throw to deny (remote role scoping); no-op-ish for local. */
  guard(name: string, args: Record<string, unknown>): void;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
function textResult(obj: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }], isError };
}

export function registerServer(server: McpServer, ctx: ToolContext): void {
  // ─────────────── RESOURCES ───────────────
  server.registerResource(
    "patient_summary",
    "patient://record/summary",
    { title: "Patient summary", description: "The complete current patient summary — diagnoses, meds, recent timeline.", mimeType: "text/plain" },
    async (uri) => {
      ctx.guard("resource:patient_summary", {});
      return { contents: [{ uri: uri.href, text: db.buildFullPatientContext(), mimeType: "text/plain" }] };
    },
  );
  server.registerResource(
    "active_medications",
    "patient://medications/active",
    { title: "Active medications", description: "Current active medications with doses.", mimeType: "application/json" },
    async (uri) => {
      ctx.guard("resource:active_medications", {});
      return { contents: [{ uri: uri.href, text: JSON.stringify(db.getActiveMedications(), null, 2), mimeType: "application/json" }] };
    },
  );
  server.registerResource(
    "active_diagnoses",
    "patient://diagnoses/active",
    { title: "Active diagnoses", description: "Current active diagnoses.", mimeType: "application/json" },
    async (uri) => {
      ctx.guard("resource:active_diagnoses", {});
      return { contents: [{ uri: uri.href, text: JSON.stringify(db.getActiveDiagnoses(), null, 2), mimeType: "application/json" }] };
    },
  );

  // ─────────────── TOOLS ───────────────
  server.registerTool(
    "get_lab_trend",
    {
      title: "Get lab trend",
      description: "Get the complete history and trend for one lab test. Accepts any common name (e.g. 'Hgb', 'haemoglobin', 'Hb') — normalised automatically.",
      inputSchema: { test_name: z.string() },
    },
    async ({ test_name }) => {
      ctx.guard("get_lab_trend", { test_name });
      const canonical = normaliseTestName(test_name);
      if (!canonical) return textResult({ error: `Unknown test name '${test_name}'. It may need adding to the alias map.` });
      return textResult(db.getLabTrend(canonical));
    },
  );

  server.registerTool(
    "get_active_medications",
    { title: "Get active medications", description: "List the patient's current active medications with doses.", inputSchema: {} },
    async () => {
      ctx.guard("get_active_medications", {});
      return textResult(db.getActiveMedications());
    },
  );

  server.registerTool(
    "get_recent_timeline",
    {
      title: "Get recent timeline",
      description: "Get the patient's recent clinical timeline (events within the last N days, most recent first).",
      inputSchema: { days: z.number().int().positive().default(30) },
    },
    async ({ days }) => {
      ctx.guard("get_recent_timeline", { days });
      return textResult(db.getRecentTimeline(days));
    },
  );

  server.registerTool(
    "check_lab_value_safety",
    {
      title: "Check lab value safety",
      description: "Score a lab value for plausibility against THIS patient's history and flag if it crosses a critical (panic) threshold.",
      inputSchema: { test_name: z.string(), value: z.number() },
    },
    async ({ test_name, value }) => {
      ctx.guard("check_lab_value_safety", { test_name, value });
      const canonical = normaliseTestName(test_name);
      if (!canonical) return textResult({ error: `Unknown test '${test_name}'` });
      const patient = db.getPatient();
      const sex = patient?.sex ?? null;
      const prior = db.priorValuesFor(canonical);
      const [conf, reason] = scorePlausibility(canonical, value, prior, sex);
      const [critical, critMsg] = isCritical(canonical, value);
      return textResult({ test: canonical, value, plausibility_confidence: conf, plausibility_reason: reason, is_critical: critical, critical_message: critMsg });
    },
  );

  server.registerTool(
    "get_critical_alerts",
    { title: "Get critical alerts", description: "Get current unacknowledged alerts (critical first).", inputSchema: {} },
    async () => {
      ctx.guard("get_critical_alerts", {});
      return textResult(db.getActiveAlerts());
    },
  );

  server.registerTool(
    "get_pending_reviews",
    { title: "Get pending reviews", description: "Get items in the human review queue needing value confirmation.", inputSchema: {} },
    async () => {
      ctx.guard("get_pending_reviews", {});
      return textResult(db.getPendingReviews());
    },
  );

  server.registerTool(
    "run_specialist_review",
    {
      title: "Run specialist review",
      description: "Run one specialist agent's assessment over the full patient record. Uses the resilient LLM router (free tiers → local Ollama fallback).",
      inputSchema: { specialty: z.string(), question: z.string() },
    },
    async ({ specialty, question }) => {
      ctx.guard("run_specialist_review", { specialty, question });
      const system = getAgentPrompt(specialty);
      if (!system) return textResult({ error: `Unknown specialty '${specialty}'` });
      const context = db.buildFullPatientContext();
      const user = `PATIENT RECORD:\n${context}\n\nQUESTION FOR YOU:\n${question}`;
      try {
        const result = await router.complete(system, user);
        return textResult({
          specialty,
          assessment: result.text,
          model_used: result.modelUsed,
          degraded_to_local: result.degraded,
          note: result.degraded ? "Generated by LOCAL model — cloud limits were exhausted. Review with extra care." : null,
        });
      } catch (e) {
        return textResult({ error: String((e as Error)?.message ?? e), fallback_advice: "Agent reasoning unavailable. The record and timeline remain accessible." });
      }
    },
  );

  server.registerTool(
    "llm_health",
    { title: "LLM health", description: "Show the health/availability of each LLM provider in the fallback chain.", inputSchema: {} },
    async () => {
      ctx.guard("llm_health", {});
      return textResult(router.status());
    },
  );

  server.registerTool(
    "run_full_mdt_consultation",
    {
      title: "Run full MDT consultation",
      description:
        "Run the FULL formal 15-agent MDT council with the objection protocol (Mode B). Each specialist assesses independently, raises formal objections, objections are resolved, and a consensus plan is synthesised. If any BLOCKER objection is unresolved, NO consensus is written and the conflict is escalated for human arbitration — everything is persisted for audit. roster: optional comma-separated specialties (e.g. 'icu,oncologist,hepatologist'); empty = the default focused roster.",
      inputSchema: { roster: z.string().default("") },
    },
    async ({ roster }) => {
      ctx.guard("run_full_mdt_consultation", { roster });
      const agents = roster.split(",").map((s) => s.trim()).filter(Boolean);
      try {
        return textResult(await runConsultation({ roster: agents.length ? agents : DEFAULT_ROSTER, trigger: "mcp_request" }));
      } catch (e) {
        return textResult({ error: String((e as Error)?.message ?? e), note: "Council unavailable; the record and timeline remain accessible." });
      }
    },
  );

  // ─────────────── RAG (external knowledge + targeted history) ───────────────
  server.registerTool(
    "search_patient_history",
    {
      title: "Search patient history",
      description:
        "Semantic search across the patient's history for a NARROW query (e.g. 'every mention of a thyroid abnormality'). For whole-patient reasoning, read the patient://record/summary resource instead — full context is safer than retrieval.",
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      ctx.guard("search_patient_history", { query });
      try {
        return textResult(await rag.searchHistory(query));
      } catch (e) {
        return textResult({ error: `History search unavailable: ${String((e as Error)?.message ?? e)}` });
      }
    },
  );

  server.registerTool(
    "verify_against_guideline",
    {
      title: "Verify against guideline",
      description: "Check a proposed treatment against the indexed WHO/NCCN/ESMO knowledge.",
      inputSchema: { treatment: z.string(), condition: z.string() },
    },
    async ({ treatment, condition }) => {
      ctx.guard("verify_against_guideline", { treatment, condition });
      try {
        return textResult({ treatment, condition, guideline_excerpts: await rag.searchGuidelines(`${condition} ${treatment}`, 3) });
      } catch (e) {
        return textResult({ error: `Guideline search unavailable: ${String((e as Error)?.message ?? e)}` });
      }
    },
  );

  server.registerTool(
    "check_drug_availability_india",
    {
      title: "Check drug availability (India)",
      description: "Look up a drug's India availability from the indexed knowledge base.",
      inputSchema: { drug: z.string() },
    },
    async ({ drug }) => {
      ctx.guard("check_drug_availability_india", { drug });
      try {
        return textResult({ drug, availability_info: await rag.searchGuidelines(`drug ${drug} india availability`, 2) });
      } catch (e) {
        return textResult({ error: `Drug lookup unavailable: ${String((e as Error)?.message ?? e)}` });
      }
    },
  );

  // Owner-only action tool (absent from clinician/caretaker scopes).
  server.registerTool(
    "confirm_review",
    {
      title: "Confirm review",
      description: "Confirm or correct a value sitting in the human review queue. Writes the human-confirmed value as the highest trust tier.",
      inputSchema: { review_id: z.number().int(), confirmed_value: z.string(), reviewer: z.string().default("owner") },
    },
    async ({ review_id, confirmed_value, reviewer }) => {
      ctx.guard("confirm_review", { review_id, confirmed_value, reviewer });
      try {
        db.confirmReview(review_id, confirmed_value, reviewer);
        return textResult({ status: "confirmed", review_id, confirmed_value, reviewer, note: "Value written as human-verified (highest trust tier)." });
      } catch (e) {
        return textResult({ error: `Could not confirm review ${review_id}: ${String((e as Error)?.message ?? e)}` });
      }
    },
  );

  // Owner-only ingestion tools (absent from clinician/caretaker scopes).
  server.registerTool(
    "ingest_document",
    {
      title: "Ingest document",
      description: "Process one document/image on disk through the full ingestion pipeline (text/OCR → extract → per-patient confidence → route to timeline or review → critical alerts). Unreadable inputs and low-confidence values go to the human review queue, never silently dropped.",
      inputSchema: { file_path: z.string() },
    },
    async ({ file_path }) => {
      ctx.guard("ingest_document", { file_path });
      try {
        return textResult(await processFile(file_path));
      } catch (e) {
        return textResult({ error: `Ingestion failed for ${file_path}: ${String((e as Error)?.message ?? e)}`, note: "The record and timeline remain accessible." });
      }
    },
  );

  server.registerTool(
    "ingest_incoming_folder",
    {
      title: "Ingest incoming folder",
      description: "Process every new file waiting in the incoming/ folder (incl. caretaker uploads). Returns a per-file summary of what was accepted, queued for review, and any alerts raised.",
      inputSchema: {},
    },
    async () => {
      ctx.guard("ingest_incoming_folder", {});
      try {
        const results = await processIncomingFolder();
        return textResult({ processed_count: results.length, results });
      } catch (e) {
        return textResult({ error: `Folder ingestion failed: ${String((e as Error)?.message ?? e)}` });
      }
    },
  );

  // ─────────────── PROMPT ───────────────
  server.registerPrompt(
    "specialist_assessment",
    {
      title: "Specialist assessment",
      description: "Load a specialist's system prompt so Claude can embody that specialist directly in conversation.",
      argsSchema: { specialty: z.string() },
    },
    ({ specialty }) => {
      ctx.guard("prompt:specialist_assessment", { specialty });
      return { messages: [{ role: "user", content: { type: "text", text: getAgentPrompt(specialty) ?? `Unknown specialty: ${specialty}` } }] };
    },
  );
}
