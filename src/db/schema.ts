/**
 * MediConsult AI (TS) — database schema and initialization.
 *
 * Single-patient SQLite database via better-sqlite3 (synchronous). WAL mode for
 * safe concurrent reads. Every timestamp stored as UTC ISO 8601; local time
 * preserved separately.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.js";

const SCHEMA = `
PRAGMA foreign_keys = ON;

-- The patient. One row.
CREATE TABLE IF NOT EXISTS patient (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    full_name       TEXT NOT NULL,
    date_of_birth   TEXT NOT NULL,
    sex             TEXT NOT NULL,
    blood_group     TEXT,
    uhid            TEXT,
    home_timezone   TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    known_allergies TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
);

-- Every clinical event, chronological, append-only.
CREATE TABLE IF NOT EXISTS timeline_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type      TEXT NOT NULL,
    event_timestamp TEXT NOT NULL,
    local_timestamp TEXT NOT NULL,
    timezone_id     TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    source_type     TEXT NOT NULL,
    source_file     TEXT,
    confidence      REAL NOT NULL DEFAULT 1.0,
    confidence_tier TEXT NOT NULL DEFAULT 'verified',
    data_json       TEXT NOT NULL,
    summary_text    TEXT,
    tags            TEXT,
    superseded_by   INTEGER,
    created_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (superseded_by) REFERENCES timeline_events(id)
);

CREATE TABLE IF NOT EXISTS lab_results (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        INTEGER NOT NULL,
    test_name       TEXT NOT NULL,
    loinc_code      TEXT,
    result_value    REAL,
    result_text     TEXT,
    unit            TEXT,
    reference_low   REAL,
    reference_high  REAL,
    flag            TEXT,
    lab_name        TEXT,
    sample_type     TEXT,
    collection_time TEXT,
    report_time     TEXT,
    FOREIGN KEY (event_id) REFERENCES timeline_events(id)
);

CREATE TABLE IF NOT EXISTS medications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        INTEGER,
    drug_name       TEXT NOT NULL,
    brand_name      TEXT,
    dose            TEXT NOT NULL,
    frequency       TEXT NOT NULL,
    route           TEXT NOT NULL,
    indication      TEXT,
    prescribed_by   TEXT,
    start_date      TEXT,
    end_date        TEXT,
    status          TEXT DEFAULT 'active',
    hold_reason     TEXT,
    dcgi_approved   INTEGER,
    available_india INTEGER,
    notes           TEXT
);

CREATE TABLE IF NOT EXISTS diagnoses (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id             INTEGER,
    diagnosis_name       TEXT NOT NULL,
    icd10_code           TEXT,
    snomed_code          TEXT,
    diagnosed_date       TEXT,
    diagnosing_physician TEXT,
    status               TEXT DEFAULT 'active',
    notes                TEXT
);

CREATE TABLE IF NOT EXISTS consultations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      TEXT NOT NULL,
    completed_at    TEXT,
    trigger_event   TEXT,
    phase_reached   INTEGER DEFAULT 0,
    consensus_plan  TEXT,
    objection_count INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'in_progress'
);

CREATE TABLE IF NOT EXISTS agent_outputs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    consultation_id INTEGER NOT NULL,
    agent_name      TEXT NOT NULL,
    phase           INTEGER NOT NULL,
    output_text     TEXT NOT NULL,
    output_type     TEXT NOT NULL,
    confidence_note TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (consultation_id) REFERENCES consultations(id)
);

CREATE TABLE IF NOT EXISTS human_review_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        INTEGER,
    review_type     TEXT NOT NULL,
    priority        TEXT DEFAULT 'normal',
    source_file     TEXT,
    extracted_value TEXT,
    alt_values      TEXT,
    image_crop_path TEXT,
    context_text    TEXT,
    patient_prior   TEXT,
    reviewer_id     TEXT,
    reviewed_at     TEXT,
    confirmed_value TEXT,
    status          TEXT DEFAULT 'pending',
    created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS source_documents (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path       TEXT NOT NULL UNIQUE,
    file_type       TEXT NOT NULL,
    file_hash       TEXT NOT NULL,
    file_size_bytes INTEGER,
    document_type   TEXT,
    received_at     TEXT NOT NULL,
    processed       INTEGER DEFAULT 0,
    processing_notes TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tier            TEXT NOT NULL,
    message         TEXT NOT NULL,
    trigger_source  TEXT,
    event_id        INTEGER,
    created_at      TEXT NOT NULL,
    acknowledged_at TEXT,
    status          TEXT DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_timeline_timestamp ON timeline_events(event_timestamp);
CREATE INDEX IF NOT EXISTS idx_timeline_type ON timeline_events(event_type);
CREATE INDEX IF NOT EXISTS idx_lab_test ON lab_results(test_name, collection_time);
CREATE INDEX IF NOT EXISTS idx_meds_status ON medications(status);
CREATE INDEX IF NOT EXISTS idx_review_status ON human_review_queue(status, priority);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status, tier);
`;

export function getDbPath(): string {
  const base = dataDir();
  mkdirSync(base, { recursive: true });
  return join(base, "patient.db");
}

/** Open a connection with sane defaults. Caller must close(). */
export function connect(): Database.Database {
  const db = new Database(getDbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

/** Create all tables. Idempotent. */
export function initDb(): void {
  const db = connect();
  try {
    db.exec(SCHEMA);
  } finally {
    db.close();
  }
}
