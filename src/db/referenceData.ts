/**
 * MediConsult AI (TS) — clinical reference data.
 *
 * Reference ranges (with absolute physiological bounds for OCR-error detection)
 * and the lab-test name normalisation map. Grounded in the Gap Resolution spec
 * (Labcorp / CAP critical values, LOINC codes).
 */

export interface RefRange {
  unit: string;
  low: number;
  high: number;
  sex?: Record<string, [number, number]>;
  abs_min: number;
  abs_max: number;
}

// abs_min/abs_max are absolute physiological bounds — any value outside these
// is almost certainly an OCR error and is flagged regardless of OCR confidence.
export const REFERENCE_RANGES: Record<string, RefRange> = {
  haemoglobin: { unit: "g/dL", low: 12.0, high: 16.0, sex: { M: [13.5, 17.5], F: [12.0, 15.5] }, abs_min: 2.0, abs_max: 25.0 },
  wbc: { unit: "10^9/L", low: 4.0, high: 11.0, abs_min: 0.0, abs_max: 200.0 },
  neutrophils_abs: { unit: "10^9/L", low: 2.0, high: 7.5, abs_min: 0.0, abs_max: 100.0 },
  platelets: { unit: "10^9/L", low: 150, high: 400, abs_min: 0, abs_max: 2000 },
  sodium: { unit: "mmol/L", low: 135, high: 145, abs_min: 90, abs_max: 190 },
  potassium: { unit: "mmol/L", low: 3.5, high: 5.1, abs_min: 1.0, abs_max: 9.0 },
  creatinine: { unit: "mg/dL", low: 0.6, high: 1.3, sex: { M: [0.7, 1.3], F: [0.6, 1.1] }, abs_min: 0.1, abs_max: 25.0 },
  urea: { unit: "mg/dL", low: 15, high: 45, abs_min: 2, abs_max: 300 },
  bilirubin_total: { unit: "mg/dL", low: 0.2, high: 1.2, abs_min: 0.0, abs_max: 50.0 },
  alt: { unit: "U/L", low: 7, high: 56, abs_min: 0, abs_max: 10000 },
  ast: { unit: "U/L", low: 10, high: 40, abs_min: 0, abs_max: 10000 },
  albumin: { unit: "g/dL", low: 3.5, high: 5.0, abs_min: 0.5, abs_max: 7.0 },
  inr: { unit: "ratio", low: 0.8, high: 1.2, abs_min: 0.5, abs_max: 15.0 },
  glucose: { unit: "mg/dL", low: 70, high: 140, abs_min: 10, abs_max: 1500 },
  calcium_total: { unit: "mg/dL", low: 8.5, high: 10.5, abs_min: 3.0, abs_max: 20.0 },
  crp: { unit: "mg/L", low: 0, high: 5, abs_min: 0, abs_max: 600 },
  procalcitonin: { unit: "ng/mL", low: 0, high: 0.5, abs_min: 0, abs_max: 1000 },
  lactate: { unit: "mmol/L", low: 0.5, high: 2.2, abs_min: 0, abs_max: 30 },
  ammonia: { unit: "umol/L", low: 11, high: 51, abs_min: 0, abs_max: 1000 },
  ldh: { unit: "U/L", low: 140, high: 280, abs_min: 0, abs_max: 50000 },
};

export interface CriticalRange {
  low: number | null;
  high: number | null;
}

// Critical (panic) value thresholds. Grounded in Labcorp / CAP standards.
// Oncology-aware: platelet/neutrophil thresholds use chemo-appropriate levels.
export const CRITICAL_VALUES: Record<string, CriticalRange> = {
  haemoglobin: { low: 7.0, high: 20.0 },
  wbc: { low: 1.5, high: 50.0 },
  neutrophils_abs: { low: 0.5, high: null },
  platelets: { low: 10, high: 1000 },
  sodium: { low: 120, high: 160 },
  potassium: { low: 2.8, high: 6.5 },
  glucose: { low: 45, high: 500 },
  calcium_total: { low: 6.5, high: 14.0 },
  bilirubin_total: { low: null, high: 10.0 },
  inr: { low: null, high: 5.0 },
  lactate: { low: null, high: 4.0 },
  ammonia: { low: null, high: 100.0 },
};

export interface AliasInfo {
  loinc: string;
  aliases: string[];
}

// Collapses lab-specific names to one canonical key linked to ranges + LOINC.
export const NAME_ALIASES: Record<string, AliasInfo> = {
  haemoglobin: { loinc: "718-7", aliases: ["hemoglobin", "haemoglobin", "hb", "hgb", "haemoglobin (hb)", "hgb."] },
  wbc: { loinc: "6690-2", aliases: ["wbc", "white blood cell", "white blood cell count", "total leukocyte count", "tlc", "total wbc count", "leucocyte count", "leukocytes"] },
  platelets: { loinc: "777-3", aliases: ["platelet", "platelet count", "plt", "platelets", "thrombocyte count"] },
  neutrophils_abs: { loinc: "751-8", aliases: ["anc", "absolute neutrophil count", "neutrophils absolute", "abs neutrophil"] },
  creatinine: { loinc: "2160-0", aliases: ["creatinine", "serum creatinine", "s. creatinine", "creat", "sr. creatinine", "creatinine - serum"] },
  sodium: { loinc: "2951-2", aliases: ["sodium", "na", "na+", "serum sodium", "s. sodium"] },
  potassium: { loinc: "2823-3", aliases: ["potassium", "k", "k+", "serum potassium", "s. potassium"] },
  bilirubin_total: { loinc: "1975-2", aliases: ["total bilirubin", "bilirubin total", "t. bilirubin", "bilirubin (total)", "s. bilirubin total", "tbil"] },
  alt: { loinc: "1742-6", aliases: ["alt", "sgpt", "alanine aminotransferase", "alt (sgpt)", "sgpt (alt)"] },
  ast: { loinc: "1920-8", aliases: ["ast", "sgot", "aspartate aminotransferase", "ast (sgot)", "sgot (ast)"] },
  glucose: { loinc: "2345-7", aliases: ["glucose", "blood glucose", "rbs", "fbs", "random blood sugar", "fasting blood sugar"] },
  urea: { loinc: "3094-0", aliases: ["urea", "blood urea", "bun", "blood urea nitrogen"] },
  albumin: { loinc: "1751-7", aliases: ["albumin", "serum albumin", "s. albumin"] },
  inr: { loinc: "34714-6", aliases: ["inr", "pt-inr", "prothrombin inr"] },
  calcium_total: { loinc: "17861-6", aliases: ["calcium", "total calcium", "serum calcium", "ca"] },
  crp: { loinc: "1988-5", aliases: ["crp", "c-reactive protein", "c reactive protein"] },
  procalcitonin: { loinc: "33959-8", aliases: ["procalcitonin", "pct"] },
  lactate: { loinc: "2524-7", aliases: ["lactate", "lactic acid", "serum lactate"] },
  ammonia: { loinc: "32693-4", aliases: ["ammonia", "serum ammonia", "nh3"] },
  ldh: { loinc: "14804-9", aliases: ["ldh", "lactate dehydrogenase"] },
};

/** Map a raw lab test name to its canonical key, or null if unknown. */
export function normaliseTestName(raw: string): string | null {
  const cleaned = raw.toLowerCase().trim().replace(/\./g, "").replace(/ {2}/g, " ");
  for (const [canonical, info] of Object.entries(NAME_ALIASES)) {
    const normAliases = info.aliases.map((a) => a.toLowerCase().replace(/\./g, ""));
    if (normAliases.includes(cleaned) || cleaned === canonical) return canonical;
  }
  return null;
}

export function getLoinc(canonical: string): string | null {
  return NAME_ALIASES[canonical]?.loinc ?? null;
}
