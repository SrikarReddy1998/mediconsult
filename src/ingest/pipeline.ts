/**
 * MediConsult AI (TS) — ingestion pipeline orchestrator.
 *
 * hash+dedupe → text extraction (OCR/PDF/docx/text) → LLM extraction (primary;
 * regex lab extraction is a fallback only when the LLM is unavailable) →
 * per-patient confidence → route (timeline vs review) → alerts.
 *
 * "Never silently fail": every value either lands as verified or in the review
 * queue with its source. Carries Python fixes #2 (out-of-bounds → review),
 * #3 (LLM labs below threshold → review + alert), #7 (report date → collection
 * time, so trends order clinically). Unreadable/blocked inputs → human review.
 */
import { createHash } from "node:crypto";
import { readFile, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";

import * as db from "../db/access.js";
import { nowUtc, scorePlausibility, isCritical, normaliseUtc, isFiniteNumber } from "../db/clinicalUtils.js";
import { normaliseTestName } from "../db/referenceData.js";
import { extractLabValues } from "./extract.js";
import { extractAll, type LlmExtraction } from "./extractFull.js";
import * as ocr from "./ocr.js";
import { checkAndAlertLab, raiseAlert } from "../alerts/delivery.js";
import { dataDir } from "../config.js";

const VERIFIED_THRESHOLD = 0.85;

export interface IngestSummary {
  file: string;
  doc_id?: number;
  status: string;
  accepted: any[];
  review: any[];
  alerts: any[];
  [k: string]: any;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function reportTimestamp(llm: { document_date?: string | null }, sidecar: any): string {
  // normaliseUtc canonicalises any parseable date to UTC ISO (…Z); a
  // non-parseable value ("May 2026", "2026-05") → null → fall back to ingestion
  // time rather than storing a garbage string that breaks ordering/toLocal().
  return normaliseUtc(llm.document_date || sidecar?.captured_at_client) ?? nowUtc();
}

/** Coerce an LLM field to something better-sqlite3 can bind (string|null),
 * so a non-scalar value (e.g. dose: ["75 mg"]) can't throw a bind error. */
function scalarField(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

async function readSidecar(path: string): Promise<any> {
  const meta = path + ".meta.json";
  if (existsSync(meta)) {
    try {
      return JSON.parse(await readFile(meta, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

const wouldBeCritical = (canonical: string | null, value: number): boolean => (canonical ? isCritical(canonical, value)[0] : false);

function storeMedsAndDiagnoses(llm: LlmExtraction, summary: IngestSummary): void {
  summary.llm_extracted = summary.llm_extracted ?? { document_type: llm.document_type, medications: llm.medications.length, diagnoses: llm.diagnoses.length, extra_labs: 0 };
  for (const med of llm.medications) {
    if (!med || typeof med !== "object") continue;
    const drug = String(scalarField(med.drug_name) ?? "").trim();
    if (!drug) continue;
    try {
      db.addMedication({ drug_name: drug, brand_name: scalarField(med.brand_name), dose: scalarField(med.dose), frequency: scalarField(med.frequency), route: scalarField(med.route), indication: scalarField(med.indication), start_date: scalarField(med.start_date), notes: scalarField(med.notes) });
    } catch {
      /* one malformed medication must not abort the whole ingest */
    }
  }
  for (const diag of llm.diagnoses) {
    if (!diag || typeof diag !== "object") continue;
    const name = String(scalarField(diag.name) ?? "").trim();
    if (!name) continue;
    try {
      db.addDiagnosis({ name, icd10: scalarField(diag.icd10), date: scalarField(diag.date), status: scalarField(diag.status), notes: scalarField(diag.notes) });
    } catch {
      /* skip malformed diagnosis */
    }
  }
}

export interface ProcessOptions {
  sourceTimezone?: string;
  /** Injectable for tests; defaults to the router-backed LLM extractor. */
  llmExtract?: (text: string) => Promise<LlmExtraction>;
}

export async function processFile(filePath: string, opts: ProcessOptions = {}): Promise<IngestSummary> {
  const sourceTimezone = opts.sourceTimezone ?? "Asia/Kolkata";
  const llmExtract = opts.llmExtract ?? extractAll;
  const path = filePath;
  if (!existsSync(path)) return { file: path, status: "error", reason: "file not found", accepted: [], review: [], alerts: [] };

  const fileHash = await sha256(path);
  if (db.documentAlreadyProcessed(fileHash)) return { file: path, status: "skipped", reason: "already processed", accepted: [], review: [], alerts: [] };

  const size = (await stat(path)).size;
  const docId = db.registerDocument(path, fileHash, size, extname(path).replace(/^\./, "").toLowerCase());
  const sidecar = await readSidecar(path);
  const summary: IngestSummary = { file: path, doc_id: docId, accepted: [], review: [], alerts: [], status: "processed" };

  // ── Step 1: text extraction ──
  let ocrResult: ocr.OcrResult;
  if (ocr.isPdf(path)) ocrResult = await ocr.extractPdfText(path);
  else if (ocr.isDocx(path)) ocrResult = await ocr.extractDocxText(path);
  else if (ocr.isText(path)) ocrResult = await ocr.extractTextFile(path);
  else if (ocr.isImage(path)) {
    ocrResult = await ocr.runImageOcr(path);
    summary.quality = { verdict: ocrResult.verdict, reason: ocrResult.reason };
    if (ocrResult.verdict === "poor") {
      const rid = db.addToReviewQueue({
        reviewType: ocrResult.ocr_available === false ? "ocr_unavailable" : "blurry_image",
        sourceFile: path,
        context: `${ocrResult.reason ?? "image unusable"}. Caption: ${sidecar.caption ?? "n/a"}. Re-take (closer, better light) or enter values manually.`,
        priority: "normal",
        imageCrop: path,
      });
      db.markProcessed(docId, "sent to review: image unusable / OCR unavailable");
      summary.status = "needs_review";
      summary.review.push({ review_id: rid, reason: ocrResult.reason });
      return summary;
    }
  } else {
    const rid = db.addToReviewQueue({ reviewType: "unknown_format", sourceFile: path, context: `Unrecognised file type. Caption: ${sidecar.caption ?? "n/a"}` });
    db.markProcessed(docId, "sent to review: unknown format");
    summary.status = "needs_review";
    summary.review.push({ review_id: rid, reason: "unknown format" });
    return summary;
  }

  summary.ocr = { engines: ocrResult.engines_used, ensemble_confidence: ocrResult.ensemble_confidence };
  const text = ocrResult.text ?? "";
  if (!text.trim()) {
    const rid = db.addToReviewQueue({ reviewType: "ocr_failed", sourceFile: path, context: ocrResult.reason ?? "No readable text extracted. Manual entry needed." });
    db.markProcessed(docId, "sent to review: no text");
    summary.status = "needs_review";
    summary.review.push({ review_id: rid, reason: ocrResult.reason ?? "no text" });
    return summary;
  }

  const patient = db.getPatient();
  const sex = patient?.sex ?? null;
  const ocrConf = ocrResult.ensemble_confidence ?? 0.7;

  // LLM extraction up front so the report date reaches BOTH lab paths (#7).
  const llm = await llmExtract(text);
  const reportTs = reportTimestamp(llm, sidecar);

  // Prefer the LLM extractor whenever it produced anything usable; the regex
  // extractor is only a FALLBACK for when the LLM is unavailable. On narrative
  // reports regex grabs numbers from headers/addresses/IDs (e.g. a street
  // number in "…& 17, Street No. 19" misread as "calcium 17"), so it must not
  // run alongside a good LLM pass and pollute the record with false criticals.
  const llmOk = llm.document_type !== "unknown" || llm.medications.length > 0 || llm.diagnoses.length > 0 || llm.lab_results.length > 0;
  const values = llmOk ? [] : extractLabValues(text);
  if (!values.length && llm.lab_results.length === 0) {
    const eid = db.addTimelineEvent({ eventType: "clinical_note", eventTimestamp: reportTs, localTimestamp: sidecar.captured_at_client ?? "unknown", sourceType: "ocr_document", data: { raw_text: text.slice(0, 5000) }, summary: "Document ingested; no structured labs auto-detected", sourceFile: path, confidence: ocrConf, confidenceTier: "provisional" });
    const rid = db.addToReviewQueue({ reviewType: "no_labs_detected", sourceFile: path, eventId: eid, context: "Document text captured but no lab values auto-detected. Review to extract any values manually." });
    storeMedsAndDiagnoses(llm, summary);
    db.markProcessed(docId, "no labs detected; raw text stored + review");
    summary.status = "partial";
    summary.review.push({ review_id: rid, reason: "no labs detected" });
    return summary;
  }

  // ── Regex-extracted labs: score, route, alert ──
  for (const v of values) {
    const canonical = v.canonical;
    const value = v.value;
    const prior = db.priorValuesFor(canonical);
    const [plausConf, plausReason] = scorePlausibility(canonical, value, prior, sex);
    const ocrQuality = Math.min(v.extractionConfidence, ocrConf);
    const combined = Math.round((plausConf * 0.75 + ocrQuality * 0.25) * 100) / 100;

    if (combined >= VERIFIED_THRESHOLD) {
      const eid = db.addTimelineEvent({ eventType: "lab_result", eventTimestamp: reportTs, localTimestamp: sidecar.captured_at_client ?? "report time", sourceType: ocr.isPdf(path) ? "lab_pdf" : "photo", data: { test: canonical, value, unit: v.unit }, summary: `${canonical} ${value} ${v.unit ?? ""}`, sourceFile: path, confidence: combined, confidenceTier: "verified", timezoneId: sourceTimezone });
      db.addLabResult({ eventId: eid, testName: canonical, value, unit: v.unit, refLow: v.refLow, refHigh: v.refHigh, collectionTime: reportTs });
      summary.accepted.push({ test: canonical, value, confidence: combined });
      const alert = await checkAndAlertLab(canonical, value, eid);
      if (alert) summary.alerts.push(alert);
    } else {
      const critical = wouldBeCritical(canonical, value);
      const rid = db.addToReviewQueue({ reviewType: "low_confidence_value", sourceFile: path, extractedValue: `${canonical} = ${value} ${v.unit ?? ""}`, altValues: [v.rawLine], context: `${plausReason}. Extraction conf ${v.extractionConfidence}, combined ${combined}.`, prior, priority: critical ? "urgent" : "normal", imageCrop: path });
      summary.review.push({ review_id: rid, test: canonical, value, confidence: combined, reason: plausReason, priority: critical ? "urgent" : "normal" });
      // SAFETY OVERRIDE: a critically abnormal value alerts the team even while unconfirmed.
      if (critical) {
        const [, critMsg] = isCritical(canonical, value);
        summary.alerts.push(await raiseAlert("urgent", `UNCONFIRMED critical value pending review: ${critMsg}. Source extraction confidence is low — please confirm in the review queue, but be aware of this finding now.`, "lab_ingestion_unconfirmed"));
      }
    }
  }

  storeMedsAndDiagnoses(llm, summary);

  // ── LLM supplemental labs: mirror the regex path (#3) — never silently drop ──
  const alreadyHandled = new Set<string>([...summary.accepted.map((a) => a.test), ...summary.review.map((r) => r.test).filter(Boolean)]);
  for (const lr of llm.lab_results) {
    const testRaw = String(lr.test ?? "").trim();
    if (!testRaw) continue;
    const canonical = normaliseTestName(testRaw);
    const label = canonical ?? testRaw;
    if (alreadyHandled.has(label)) continue;

    // A missing / non-numeric / non-finite value must NOT be silently dropped
    // (the "never silently fail" guarantee) — route it to human review. Covers
    // "10^3", "<0.5", "positive", NaN, etc.
    const value = lr.value == null ? NaN : Number(lr.value);
    if (!isFiniteNumber(value)) {
      const shown = lr.value ?? (lr as any).text_value;
      const rid = db.addToReviewQueue({ reviewType: "unparseable_value", sourceFile: path, extractedValue: `${label} = ${shown}`, context: `LLM-extracted a non-numeric/unparseable value for '${testRaw}'. Needs manual entry.`, priority: "normal", imageCrop: path });
      summary.review.push({ review_id: rid, test: label, value: shown, reason: "unparseable value", source: "llm" });
      alreadyHandled.add(label);
      continue;
    }

    const prior = canonical ? db.priorValuesFor(canonical) : [];
    const [plausConf, plausReason] = scorePlausibility(canonical, value, prior, sex);

    if (canonical && plausConf >= VERIFIED_THRESHOLD) {
      const eid = db.addTimelineEvent({ eventType: "lab_result", eventTimestamp: reportTs, localTimestamp: reportTs, sourceType: "llm_extracted", data: { test: canonical, value, unit: lr.unit }, summary: `${canonical} ${value} ${lr.unit ?? ""}`, sourceFile: path, confidence: plausConf, confidenceTier: "verified", timezoneId: sourceTimezone });
      db.addLabResult({ eventId: eid, testName: canonical, value, unit: lr.unit ?? null, refLow: lr.ref_low ?? null, refHigh: lr.ref_high ?? null, flag: lr.flag ?? null, collectionTime: reportTs });
      summary.accepted.push({ test: canonical, value, confidence: plausConf, source: "llm" });
      summary.llm_extracted.extra_labs += 1;
      const alert = await checkAndAlertLab(canonical, value, eid);
      if (alert) summary.alerts.push(alert);
    } else {
      const critical = wouldBeCritical(canonical, value);
      const reason = canonical ? plausReason : `test '${testRaw}' is not in the reference map`;
      const rid = db.addToReviewQueue({ reviewType: "low_confidence_value", sourceFile: path, extractedValue: `${label} = ${value} ${lr.unit ?? ""}`, context: `LLM-extracted. ${reason}. Plausibility ${plausConf}.`, prior, priority: critical ? "urgent" : "normal", imageCrop: path });
      summary.review.push({ review_id: rid, test: label, value, confidence: plausConf, reason, priority: critical ? "urgent" : "normal", source: "llm" });
      alreadyHandled.add(label);
      if (critical && canonical) {
        const [, critMsg] = isCritical(canonical, value);
        summary.alerts.push(await raiseAlert("urgent", `UNCONFIRMED critical value pending review: ${critMsg}. LLM-extracted; source confidence low — please confirm in the review queue, but be aware of this finding now.`, "lab_ingestion_unconfirmed_llm"));
      }
    }
  }

  db.markProcessed(docId, `${summary.accepted.length} labs, ${summary.review.length} to review, ${summary.alerts.length} alerts`);
  return summary;
}

export async function processIncomingFolder(): Promise<IngestSummary[]> {
  // Intake folder: defaults to <dataDir>/incoming, but can point at any folder
  // (e.g. a user's own reports directory) via MEDICONSULT_INCOMING.
  const incoming = process.env.MEDICONSULT_INCOMING ?? join(dataDir(), "incoming");
  const results: IngestSummary[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(incoming, { recursive: true });
  } catch {
    return results; // no incoming folder yet
  }
  for (const rel of entries.sort()) {
    if (rel.endsWith(".meta.json")) continue;
    const full = join(incoming, rel);
    try {
      if ((await stat(full)).isFile()) results.push(await processFile(full));
    } catch {
      /* skip unreadable entries */
    }
  }
  return results;
}
