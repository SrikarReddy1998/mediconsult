/**
 * MediConsult AI (TS) — lab value extraction from OCR/text.
 *
 * Turns raw text into structured (test, value, unit, reference range) records,
 * mapping each test to its canonical name. Extracts conservatively.
 *
 * Carries Python fix #2: a value outside physiological bounds is SURFACED at low
 * confidence (so the pipeline routes it to human review), never silently dropped.
 */
import { REFERENCE_RANGES, NAME_ALIASES } from "../db/referenceData.js";

const NUM = String.raw`[-+]?\d{1,3}(?:[, ]\d{3})*(?:\.\d+)?|\d+\.?\d*`;
const RANGE = new RegExp(`[\\(\\[]?\\s*(${NUM})\\s*(?:-|–|to)\\s*(${NUM})\\s*[\\)\\]]?`);

export interface ExtractedValue {
  canonical: string;
  rawName: string;
  value: number;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  extractionConfidence: number;
  rawLine: string;
}

function toFloat(token: string | undefined | null): number | null {
  if (token == null) return null;
  const cleaned = token.replace(/,/g, "").replace(/ /g, "").trim();
  if (cleaned === "") return null;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Short-alias false-context guards. "ca"/"k" collide with common non-panel
// labels in this patient population: "CA 19-9"/"CA 15-3"/"CA-125" are tumor
// markers (NOT calcium); "Vitamin K"/"Vit K" is NOT potassium. A marker code has
// a hyphenated digit group (19-9) or 3-digit code (125); a real "Ca 9.2" reading
// has neither, so it is unaffected.
const CALCIUM_MARKER = /\bca[\s.\-]*\d+\s*-\s*\d|\bca[\s.\-]*\d{3}\b/i;
const VITAMIN_K = /\bvit(?:amin|\.)?\s*k\b/i;

function aliasExcluded(canonical: string, line: string): boolean {
  if (canonical === "calcium_total" && CALCIUM_MARKER.test(line)) return true;
  if (canonical === "potassium" && VITAMIN_K.test(line)) return true;
  return false;
}

function findTestInLine(line: string): string | null {
  const low = line.toLowerCase();
  const candidates: [number, string][] = [];
  for (const [canonical, info] of Object.entries(NAME_ALIASES)) {
    if (aliasExcluded(canonical, line)) continue; // false context (tumor marker / vitamin K)
    for (const alias of [...info.aliases, canonical]) {
      const a = alias.toLowerCase();
      if (new RegExp(`(?<![a-z])${escapeRegExp(a)}(?![a-z])`).test(low)) candidates.push([a.length, canonical]);
    }
  }
  if (!candidates.length) return null;
  candidates.sort((x, y) => y[0] - x[0]); // longest match wins
  return candidates[0][1];
}

function matchedName(line: string, canonical: string): string {
  const low = line.toLowerCase();
  const aliases = [...NAME_ALIASES[canonical].aliases, canonical].sort((a, b) => b.length - a.length);
  for (const alias of aliases) if (low.includes(alias.toLowerCase())) return alias;
  return canonical;
}

function parseValueLine(line: string, canonical: string) {
  const ref = REFERENCE_RANGES[canonical];
  const expectedUnit = ref?.unit;

  // Pull out any reference range so its numbers aren't mistaken for the result.
  let refLow: number | null = null;
  let refHigh: number | null = null;
  let rangeStart = -1;
  let rangeEnd = -1;
  const rm = RANGE.exec(line);
  if (rm) {
    const rl = toFloat(rm[1]);
    const rh = toFloat(rm[2]);
    if (rl != null && rh != null && rl < rh && ref && ref.abs_min <= rl && rh <= ref.abs_max) {
      refLow = rl;
      refHigh = rh;
      rangeStart = rm.index;
      rangeEnd = rm.index + rm[0].length;
    }
  }

  let work = rangeStart >= 0 ? line.slice(0, rangeStart) + " " + line.slice(rangeEnd) : line;
  work = work.replace(new RegExp(escapeRegExp(matchedName(line, canonical)), "gi"), " ");

  // Strip noise whose digits must NOT be mistaken for the result value:
  //  - the unit, incl. scientific notation "10^9/L"/"x10^3" (whose "10"/"9" are
  //    in-bounds and would silently replace an out-of-bounds true value, e.g.
  //    WBC 250 → 10),
  //  - dates, "(age NN)", and 4-digit years.
  if (expectedUnit) work = work.replace(new RegExp(escapeRegExp(expectedUnit), "gi"), " ");
  work = work.replace(/(?:x|×)?\s*10\s*[\^*]\s*\d+/gi, " ");
  work = work.replace(/\(\s*age\s+\d+\s*\)/gi, " ");
  work = work.replace(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g, " ");
  work = work.replace(/\b(?:19|20)\d{2}\b/g, " ");

  const nums = work.match(new RegExp(NUM, "g")) ?? [];
  let value: number | null = null;
  let outOfBounds: number | null = null;
  for (const n of nums) {
    const v = toFloat(n);
    if (v == null) continue;
    if (ref && !(ref.abs_min <= v && v <= ref.abs_max)) {
      if (outOfBounds == null) outOfBounds = v; // remember first implausible candidate
      continue;
    }
    value = v;
    break;
  }

  // SAFETY (#2): surface an out-of-bounds value instead of dropping it.
  let implausible = false;
  if (value == null && outOfBounds != null) {
    value = outOfBounds;
    implausible = true;
  }
  if (value == null) return null;

  const unitConf = expectedUnit && line.toLowerCase().includes(expectedUnit.toLowerCase()) ? 1.0 : 0.7;
  let conf = (refLow != null ? 0.85 : 0.75) * unitConf;
  if (implausible) conf = Math.min(conf, 0.2); // low → pipeline routes to review

  return { value, unit: expectedUnit ?? null, refLow, refHigh, conf: Math.round(conf * 100) / 100 };
}

export function extractLabValues(text: string): ExtractedValue[] {
  const results: ExtractedValue[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.length < 3) continue;
    const canonical = findTestInLine(line);
    if (!canonical) continue;
    const parsed = parseValueLine(line, canonical);
    if (!parsed) continue;
    const key = `${canonical}:${parsed.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      canonical,
      rawName: matchedName(line, canonical),
      value: parsed.value,
      unit: parsed.unit,
      refLow: parsed.refLow,
      refHigh: parsed.refHigh,
      extractionConfidence: parsed.conf,
      rawLine: line,
    });
  }
  return results;
}
