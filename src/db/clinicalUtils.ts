/**
 * MediConsult AI (TS) — timezone handling + per-patient confidence scoring.
 *
 * Timezone: everything stored UTC, displayed IST (via Intl). Confidence:
 * per-patient clinical plausibility — a value is scored against THIS patient's
 * own history and absolute physiological bounds.
 *
 * Carries the Python fixes: #2 (out-of-bounds → 0.05 so callers route to
 * review) and #8 (accurate normal-range reason string, no dead code).
 */
import { REFERENCE_RANGES, CRITICAL_VALUES } from "./referenceData.js";

export function nowUtc(): string {
  return new Date().toISOString();
}

/** True only for a real, finite number (rejects NaN, ±Infinity, non-number). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Normalise a date/datetime string to canonical UTC ISO 8601 (…Z), or null if
 * it is not a parseable date. A bare YYYY-MM-DD is anchored to midday UTC.
 * This is the single gate that keeps event_timestamp/collection_time strictly
 * ISO + UTC (all "…Z"), so string-ordering and toLocal() never break.
 */
export function normaliseUtc(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Accept ONLY strict ISO-8601 date or datetime. JS `new Date()` would happily
  // (and non-deterministically, by locale/timezone) parse "May 2026", "2026-05",
  // "13/05/2026" — which we must reject so the caller falls back to ingestion
  // time rather than storing an ambiguous/locale-dependent instant.
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const isoDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s);
  if (!bareDate && !isoDateTime) return null;
  const d = new Date(bareDate ? `${s}T12:00:00Z` : s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Convert stored UTC ISO to a human-readable local string.
 *
 * Defensive: a malformed timestamp OR an unknown timezone must never throw
 * (that would take down getRecentTimeline / buildFullPatientContext and every
 * agent read). Falls back to a safe string instead of raising.
 */
export function toLocal(utcIso: string, tzId = "Asia/Kolkata"): string {
  const d = new Date(utcIso);
  if (isNaN(d.getTime())) return utcIso; // non-ISO (e.g. "report time") → passthrough
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tzId,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    const suffix = tzId === "Asia/Kolkata" ? "IST" : tzId;
    return `${fmt.format(d)} ${suffix}`;
  } catch {
    return d.toISOString(); // invalid timeZone → safe UTC fallback
  }
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population standard deviation (matches Python statistics.pstdev). */
function pstdev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

/**
 * Score how plausible a lab value is FOR THIS PATIENT.
 * Returns [confidence 0..1, reason].
 */
export function scorePlausibility(
  canonicalTest: string | null,
  value: number,
  priorValues: number[] | null = null,
  sex: string | null = null,
): [number, string] {
  // 0. Reject a missing / non-finite value (NaN, ±Infinity) rather than letting
  // it slip through as a high-confidence "verified" value.
  if (!isFiniteNumber(value)) {
    return [0.05, `value ${value} is missing or not a finite number — cannot verify`];
  }

  const ref = canonicalTest ? REFERENCE_RANGES[canonicalTest] : undefined;
  if (!ref) return [0.7, "no reference range for this test; accepted provisionally"];

  // 1. Absolute physiological bounds — outside = almost certainly OCR error.
  if (value < ref.abs_min || value > ref.abs_max) {
    return [
      0.05,
      `value ${value} is outside physiological bounds [${ref.abs_min}, ${ref.abs_max}] — likely OCR error`,
    ];
  }

  // 2. Deviation from THIS patient's own baseline.
  if (priorValues && priorValues.length >= 3) {
    const mu = mean(priorValues);
    const sigma = pstdev(priorValues) || 0.001;
    const z = Math.abs(value - mu) / sigma;
    if (z > 4) {
      return [
        0.45,
        `value ${value} is ${z.toFixed(1)} SD from this patient's baseline (mean ${mu.toFixed(1)}) — review recommended`,
      ];
    }
    if (z > 3) {
      return [0.65, `value ${value} is ${z.toFixed(1)} SD from baseline — plausible but flagged for awareness`];
    }
  }

  // 3. Passed the implausibility gates → accepted. Use the sex-specific normal
  // range only to describe the value honestly (abnormal-but-plausible values
  // are still accepted; the H/L flag records abnormality separately).
  let [low, high] = [ref.low, ref.high];
  if (sex && ref.sex && ref.sex[sex]) [low, high] = ref.sex[sex];

  if (low <= value && value <= high) return [0.92, "within normal range for this patient"];
  return [
    0.92,
    `value ${value} is outside the normal range [${low}, ${high}] but physiologically plausible and consistent with this patient's baseline`,
  ];
}

/** Check whether a value crosses a critical (panic) threshold.
 * Thresholds are INCLUSIVE (<=/>=): a value exactly on the panic threshold
 * (platelets == 10, sodium == 120) is critical. Non-finite is never critical. */
export function isCritical(canonicalTest: string | null, value: number): [boolean, string] {
  if (!isFiniteNumber(value)) return [false, ""];
  const cv = canonicalTest ? CRITICAL_VALUES[canonicalTest] : undefined;
  if (!cv) return [false, ""];
  if (cv.low != null && value <= cv.low) {
    return [true, `${canonicalTest} ${value} is at or below critical threshold ${cv.low}`];
  }
  if (cv.high != null && value >= cv.high) {
    return [true, `${canonicalTest} ${value} is at or above critical threshold ${cv.high}`];
  }
  return [false, ""];
}
