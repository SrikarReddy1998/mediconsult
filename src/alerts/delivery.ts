/**
 * MediConsult AI (TS) — alert delivery.
 *
 * Three tiers: critical (immediate), urgent (soon), routine (stored only).
 * Delivery uses ntfy.sh (free push, no account); every alert is also written to
 * the DB so it surfaces via get_critical_alerts. Mirrors the Python delivery.py.
 */
import * as db from "../db/access.js";
import { isCritical } from "../db/clinicalUtils.js";

function ntfyTopic(): string | undefined {
  return process.env.MEDICONSULT_NTFY_TOPIC;
}

async function sendNtfy(title: string, message: string, priority: string, tags: string): Promise<boolean> {
  const topic = ntfyTopic();
  if (!topic) return false; // not configured; alert still stored in DB
  // HTTP header values must be ByteString; a non-ASCII Title (emoji, em-dash,
  // accented patient name) makes fetch throw and would SILENTLY drop the push.
  // Strip Title to ASCII (emoji is carried via Tags; full text is in the body).
  const safeTitle = title.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim() || "MediConsult alert";
  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: { Title: safeTitle, Priority: priority, Tags: tags },
      body: message,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface AlertResult {
  alert_id: number;
  tier: string;
  delivered: boolean;
  message: string;
}

/** Raise an alert: store it in the DB and deliver per its tier. */
export async function raiseAlert(tier: string, message: string, source: string | null = null, eventId: number | null = null): Promise<AlertResult> {
  const patient = db.getPatient();
  const name = patient?.full_name ?? "Patient";
  const alertId = db.addAlert(tier, message, source, eventId);

  let delivered = false;
  if (tier === "critical") delivered = await sendNtfy(`CRITICAL - ${name}`, message, "urgent", "rotating_light,hospital");
  else if (tier === "urgent") delivered = await sendNtfy(`Urgent - ${name}`, message, "high", "warning");
  // routine: stored only, no push

  return { alert_id: alertId, tier, delivered, message };
}

/** Check a newly-ingested lab value against critical thresholds; alert if needed. */
export async function checkAndAlertLab(canonical: string, value: number, eventId: number | null = null): Promise<AlertResult | null> {
  const [critical, msg] = isCritical(canonical, value);
  if (critical) return raiseAlert("critical", msg, "lab_ingestion", eventId);
  return null;
}
