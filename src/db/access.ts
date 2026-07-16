/**
 * MediConsult AI (TS) — database access layer.
 *
 * All reads/writes go through here. Functions return plain objects so they
 * serialise cleanly to MCP tool responses. Mirrors the Python access.py,
 * including fix #5 (get_recent_timeline honours the `days` window).
 */
import type BetterSqlite3 from "better-sqlite3";
import { connect } from "./schema.js";
import { toLocal, nowUtc } from "./clinicalUtils.js";

function withDb<T>(fn: (db: BetterSqlite3.Database) => T): T {
  const db = connect();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ── Patient ──────────────────────────────────────────────────────────────

export interface PatientInput {
  fullName: string;
  dateOfBirth: string;
  sex: string;
  bloodGroup?: string | null;
  uhid?: string | null;
  homeTimezone?: string;
  allergies?: unknown[] | null;
}

export function getPatient(): Record<string, any> | null {
  return withDb((db) => {
    const row = db.prepare("SELECT * FROM patient WHERE id = 1").get();
    return (row as Record<string, any>) ?? null;
  });
}

export function upsertPatient(p: PatientInput): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO patient (id, full_name, date_of_birth, sex, blood_group, uhid, home_timezone, known_allergies)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         full_name=excluded.full_name, date_of_birth=excluded.date_of_birth,
         sex=excluded.sex, blood_group=excluded.blood_group,
         uhid=excluded.uhid, home_timezone=excluded.home_timezone,
         known_allergies=excluded.known_allergies`,
    ).run(
      p.fullName,
      p.dateOfBirth,
      p.sex,
      p.bloodGroup ?? null,
      p.uhid ?? null,
      p.homeTimezone ?? "Asia/Kolkata",
      JSON.stringify(p.allergies ?? []),
    );
  });
}

// ── Timeline + labs ────────────────────────────────────────────────────────

export interface TimelineEventInput {
  eventType: string;
  eventTimestamp: string;
  localTimestamp: string;
  sourceType: string;
  data: unknown;
  summary?: string | null;
  timezoneId?: string;
  sourceFile?: string | null;
  confidence?: number;
  confidenceTier?: string;
  tags?: unknown[] | null;
}

export function addTimelineEvent(e: TimelineEventInput): number {
  return withDb((db) => {
    const info = db
      .prepare(
        `INSERT INTO timeline_events
           (event_type, event_timestamp, local_timestamp, timezone_id, source_type,
            source_file, confidence, confidence_tier, data_json, summary_text, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.eventType,
        e.eventTimestamp,
        e.localTimestamp,
        e.timezoneId ?? "Asia/Kolkata",
        e.sourceType,
        e.sourceFile ?? null,
        e.confidence ?? 1.0,
        e.confidenceTier ?? "verified",
        JSON.stringify(e.data),
        e.summary ?? null,
        JSON.stringify(e.tags ?? []),
      );
    return Number(info.lastInsertRowid);
  });
}

export interface LabResultInput {
  eventId: number;
  testName: string;
  value?: number | null;
  text?: string | null;
  unit?: string | null;
  refLow?: number | null;
  refHigh?: number | null;
  flag?: string | null;
  loinc?: string | null;
  labName?: string | null;
  sampleType?: string | null;
  collectionTime?: string | null;
  reportTime?: string | null;
}

export function addLabResult(r: LabResultInput): number {
  return withDb((db) => {
    const info = db
      .prepare(
        `INSERT INTO lab_results
           (event_id, test_name, loinc_code, result_value, result_text, unit,
            reference_low, reference_high, flag, lab_name, sample_type,
            collection_time, report_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.eventId,
        r.testName,
        r.loinc ?? null,
        r.value ?? null,
        r.text ?? null,
        r.unit ?? null,
        r.refLow ?? null,
        r.refHigh ?? null,
        r.flag ?? null,
        r.labName ?? null,
        r.sampleType ?? null,
        r.collectionTime ?? null,
        r.reportTime ?? null,
      );
    return Number(info.lastInsertRowid);
  });
}

export function getLabTrend(canonicalTest: string, limit = 20): Record<string, any> {
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT result_value, unit, collection_time, flag, lab_name
         FROM lab_results
         WHERE test_name = ? AND result_value IS NOT NULL
         ORDER BY collection_time ASC
         LIMIT ?`,
      )
      .all(canonicalTest, limit) as Record<string, any>[];
    let trend = "insufficient_data";
    if (rows.length >= 2) {
      const first = rows[0].result_value as number;
      const last = rows[rows.length - 1].result_value as number;
      if (first <= 0) {
        // Ratio test degenerates at a zero/negative baseline — compare directly.
        trend = last > first ? "rising" : last < first ? "falling" : "stable";
      } else if (last > first * 1.1) trend = "rising";
      else if (last < first * 0.9) trend = "falling";
      else trend = "stable";
    }
    return { test: canonicalTest, count: rows.length, values: rows, trend };
  });
}

export function priorValuesFor(canonicalTest: string, limit = 10): number[] {
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT result_value FROM lab_results
         WHERE test_name = ? AND result_value IS NOT NULL
         ORDER BY collection_time DESC LIMIT ?`,
      )
      .all(canonicalTest, limit) as { result_value: number }[];
    return rows.map((r) => r.result_value);
  });
}

// ── Medications / diagnoses ──────────────────────────────────────────────────

export function getActiveMedications(): Record<string, any>[] {
  return withDb(
    (db) => db.prepare("SELECT * FROM medications WHERE status = 'active' ORDER BY drug_name").all() as Record<string, any>[],
  );
}

export function getActiveDiagnoses(): Record<string, any>[] {
  return withDb(
    (db) =>
      db.prepare("SELECT * FROM diagnoses WHERE status = 'active' ORDER BY diagnosed_date DESC").all() as Record<string, any>[],
  );
}

// ── Timeline read (fix #5: honour the days window) ──────────────────────────

export function getRecentTimeline(days = 30, limit = 100): Record<string, any>[] {
  // Clamp so an absurd `days` can't produce an Invalid Date → RangeError, and a
  // negative value can't push the cutoff into the future.
  const safeDays = Math.max(0, Math.min(Math.trunc(days) || 0, 73000)); // ~200 years
  const cutoff = new Date(Date.now() - safeDays * 86_400_000).toISOString();
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT * FROM timeline_events
         WHERE superseded_by IS NULL AND event_timestamp >= ?
         ORDER BY event_timestamp DESC LIMIT ?`,
      )
      .all(cutoff, limit) as Record<string, any>[];
    return rows.map((r) => ({ ...r, display_time: toLocal(r.event_timestamp, r.timezone_id) }));
  });
}

// ── Human review queue ───────────────────────────────────────────────────────

export interface ReviewInput {
  reviewType: string;
  sourceFile?: string | null;
  extractedValue?: string | null;
  altValues?: unknown[] | null;
  context?: string | null;
  prior?: unknown[] | null;
  priority?: string;
  imageCrop?: string | null;
  eventId?: number | null;
}

export function addToReviewQueue(r: ReviewInput): number {
  return withDb((db) => {
    const info = db
      .prepare(
        `INSERT INTO human_review_queue
           (event_id, review_type, priority, source_file, extracted_value,
            alt_values, image_crop_path, context_text, patient_prior)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.eventId ?? null,
        r.reviewType,
        r.priority ?? "normal",
        r.sourceFile ?? null,
        r.extractedValue ?? null,
        JSON.stringify(r.altValues ?? []),
        r.imageCrop ?? null,
        r.context ?? null,
        JSON.stringify(r.prior ?? []),
      );
    return Number(info.lastInsertRowid);
  });
}

export function getPendingReviews(): Record<string, any>[] {
  return withDb(
    (db) =>
      db
        .prepare(
          `SELECT * FROM human_review_queue WHERE status = 'pending'
           ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at ASC`,
        )
        .all() as Record<string, any>[],
  );
}

export function confirmReview(reviewId: number, confirmedValue: string, reviewer: string): void {
  const row = withDb((db) => {
    const r = db.prepare("SELECT * FROM human_review_queue WHERE id = ?").get(reviewId) as Record<string, any> | undefined;
    db.prepare(
      `UPDATE human_review_queue
       SET confirmed_value = ?, reviewer_id = ?, status = 'reviewed', reviewed_at = datetime('now')
       WHERE id = ?`,
    ).run(confirmedValue, reviewer, reviewId);
    return r;
  });
  if (!row) return;
  // Promote the human-confirmed value into the timeline at the highest trust tier
  // so it actually enters the clinical record (buildFullPatientContext reads the
  // timeline). Without this a "confirmed" value would sit in the queue forever and
  // never reach the record or the specialist review — the tool's stated contract.
  const label = String(row.extracted_value ?? "").split("=")[0].trim() || row.review_type || "reviewed value";
  addTimelineEvent({
    eventType: "lab_result",
    eventTimestamp: nowUtc(),
    localTimestamp: "human-confirmed",
    sourceType: "human_confirmed",
    data: { test: label, confirmed_value: confirmedValue, original_extracted: row.extracted_value ?? null },
    summary: `${label}: ${confirmedValue} (human-confirmed by ${reviewer})`,
    sourceFile: row.source_file ?? null,
    confidence: 1.0,
    confidenceTier: "verified",
  });
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export function addAlert(tier: string, message: string, source: string | null = null, eventId: number | null = null): number {
  return withDb((db) => {
    const info = db
      .prepare(
        `INSERT INTO alerts (tier, message, trigger_source, event_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(tier, message, source, eventId, new Date().toISOString());
    return Number(info.lastInsertRowid);
  });
}

export function getActiveAlerts(): Record<string, any>[] {
  return withDb(
    (db) =>
      db
        .prepare(
          `SELECT * FROM alerts WHERE status = 'active'
           ORDER BY CASE tier WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, created_at DESC`,
        )
        .all() as Record<string, any>[],
  );
}

// ── Full context for agent reasoning ─────────────────────────────────────────

export function buildFullPatientContext(): string {
  const patient = getPatient();
  if (!patient) return "No patient record exists yet.";
  const dx = getActiveDiagnoses();
  const meds = getActiveMedications();
  const recent = getRecentTimeline(3650, 40); // wide window for the summary

  const lines: string[] = [
    `PATIENT: ${patient.full_name}, DOB ${patient.date_of_birth}, ${patient.sex}, blood group ${patient.blood_group ?? "unknown"}`,
    `UHID: ${patient.uhid ?? "n/a"}`,
    "",
    "ACTIVE DIAGNOSES:",
  ];
  for (const d of dx) lines.push(`  - ${d.diagnosis_name} (since ${d.diagnosed_date ?? "?"})`);
  lines.push("", "ACTIVE MEDICATIONS:");
  for (const m of meds) lines.push(`  - ${m.drug_name} ${m.dose} ${m.frequency} (${m.route})`);
  lines.push("", "RECENT TIMELINE (most recent first):");
  for (const e of recent.slice(0, 25)) lines.push(`  [${e.display_time}] ${e.event_type}: ${e.summary_text ?? ""}`);
  return lines.join("\n");
}

// ── Consultations (MDT council persistence) ──────────────────────────────────

export function createConsultation(trigger: string): number {
  return withDb((db) => {
    const info = db.prepare("INSERT INTO consultations (started_at, trigger_event, status) VALUES (?, ?, 'in_progress')").run(nowUtc(), trigger);
    return Number(info.lastInsertRowid);
  });
}

export function completeConsultation(id: number, consensus: string, objectionCount: number): void {
  withDb((db) => {
    db.prepare(
      "UPDATE consultations SET completed_at = ?, status = 'complete', phase_reached = 4, consensus_plan = ?, objection_count = ? WHERE id = ?",
    ).run(nowUtc(), consensus, objectionCount, id);
  });
}

// ── Source documents + LLM-extracted meds/diagnoses (ingestion) ─────────────

export function documentAlreadyProcessed(fileHash: string): boolean {
  return withDb((db) => db.prepare("SELECT 1 FROM source_documents WHERE file_hash = ? AND processed = 1").get(fileHash) != null);
}

export function registerDocument(filePath: string, fileHash: string, fileSize: number, fileType: string, docType: string | null = null): number {
  return withDb((db) => {
    db.prepare(
      `INSERT INTO source_documents (file_path, file_type, file_hash, file_size_bytes, document_type, received_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET file_hash = excluded.file_hash`,
    ).run(filePath, fileType, fileHash, fileSize, docType, nowUtc());
    const row = db.prepare("SELECT id FROM source_documents WHERE file_path = ?").get(filePath) as { id: number };
    return row.id;
  });
}

export function markProcessed(docId: number, notes: string): void {
  withDb((db) => {
    db.prepare("UPDATE source_documents SET processed = 1, processing_notes = ? WHERE id = ?").run(notes, docId);
  });
}

export function addMedication(m: {
  drug_name: string;
  brand_name?: string | null;
  dose?: string | null;
  frequency?: string | null;
  route?: string | null;
  indication?: string | null;
  start_date?: string | null;
  notes?: string | null;
}): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO medications (drug_name, brand_name, dose, frequency, route, indication, start_date, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).run(m.drug_name, m.brand_name ?? null, m.dose ?? "", m.frequency ?? "", m.route ?? "oral", m.indication ?? null, m.start_date ?? null, m.notes ?? null);
  });
}

export function addDiagnosis(d: { name: string; icd10?: string | null; date?: string | null; status?: string | null; notes?: string | null }): void {
  withDb((db) => {
    db.prepare(
      "INSERT INTO diagnoses (diagnosis_name, icd10_code, diagnosed_date, status, notes) VALUES (?, ?, ?, ?, ?)",
    ).run(d.name, d.icd10 ?? null, d.date ?? null, d.status ?? "active", d.notes ?? null);
  });
}

const PHASE_NUM: Record<string, number> = { assessment: 1, objection: 2, resolution: 3, consensus: 4 };

export function addAgentOutput(
  consultationId: number,
  turn: { agent: string; phase: string; text: string; modelUsed: string; degraded: boolean },
  outputType: string,
): void {
  withDb((db) => {
    const note = `model=${turn.modelUsed}${turn.degraded ? " (LOCAL fallback)" : ""}`;
    db.prepare(
      "INSERT INTO agent_outputs (consultation_id, agent_name, phase, output_text, output_type, confidence_note) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(consultationId, turn.agent, PHASE_NUM[turn.phase] ?? 0, turn.text, outputType, note);
  });
}
