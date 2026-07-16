/**
 * MediConsult AI (TS) — regression tests for the edge-case hardening pass.
 * Mirrors the Python tests/test_edge_cases.py. No LLM/network required.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(() => {
  process.env.MEDICONSULT_DATA = mkdtempSync(join(tmpdir(), "medi-edge-"));
});

import { normaliseUtc, toLocal, scorePlausibility, isCritical, isFiniteNumber } from "../src/db/clinicalUtils.js";
import { extractLabValues } from "../src/ingest/extract.js";
import { parseObjections, matchSpecialty } from "../src/agents/council.js";
import { initDb } from "../src/db/schema.js";
import * as db from "../src/db/access.js";

describe("timestamp normalisation + defensive toLocal", () => {
  it("normaliseUtc canonicalises or rejects", () => {
    expect(normaliseUtc("2026-05-20")!.startsWith("2026-05-20T12:00:00")).toBe(true);
    expect(normaliseUtc("2026-05-20T09:00:00+05:30")!.startsWith("2026-05-20T03:30")).toBe(true);
    expect(normaliseUtc("May 2026")).toBeNull();
    expect(normaliseUtc("2026-05")).toBeNull();
    expect(normaliseUtc("")).toBeNull();
    expect(normaliseUtc(null)).toBeNull();
  });
  it("toLocal never throws on bad input", () => {
    expect(toLocal("not a date")).toBe("not a date"); // truly unparseable → passthrough
    expect(toLocal("2026-05-20T12:00:00Z", "Bad/Zone")).toContain("2026"); // bad tz → safe fallback
  });
});

describe("non-finite values + inclusive criticals", () => {
  it("scorePlausibility rejects non-finite", () => {
    expect(scorePlausibility("potassium", NaN, null, "F")[0]).toBe(0.05);
    expect(scorePlausibility("potassium", Infinity, null, "F")[0]).toBe(0.05);
    expect(scorePlausibility("potassium", 4.1, null, "F")[0]).toBe(0.92);
    expect(isFiniteNumber(NaN)).toBe(false);
  });
  it("isCritical is inclusive at the threshold", () => {
    expect(isCritical("sodium", 120)[0]).toBe(true);
    expect(isCritical("platelets", 10)[0]).toBe(true);
    expect(isCritical("potassium", 6.5)[0]).toBe(true);
    expect(isCritical("potassium", NaN)[0]).toBe(false);
  });
});

describe("extraction robustness", () => {
  it("unit digits (10^9/L) do not replace the true value", () => {
    const vals = extractLabValues("WBC 250 10^9/L (4.0-11.0)");
    const wbc = vals.find((v) => v.canonical === "wbc");
    expect(wbc?.value).toBe(250); // not 10
    expect(wbc!.extractionConfidence).toBeLessThanOrEqual(0.2);
  });
  it("tumor markers are not misread as calcium", () => {
    for (const line of ["CA 19-9: 35 U/mL", "CA 15-3 28", "CA-125 40"]) {
      expect(extractLabValues(line).some((v) => v.canonical === "calcium_total")).toBe(false);
    }
  });
  it("real calcium still extracted", () => {
    const ca = extractLabValues("Ca 9.2 mg/dL (8.5-10.5)").find((v) => v.canonical === "calcium_total");
    expect(ca?.value).toBe(9.2);
  });
  it("vitamin K is not potassium; date prefix is not the value", () => {
    expect(extractLabValues("Vitamin K 1.2").some((v) => v.canonical === "potassium")).toBe(false);
    const hb = extractLabValues("12-03-2026 Haemoglobin 6.0 g/dL (12.0-16.0)").find((v) => v.canonical === "haemoglobin");
    expect(hb?.value).toBe(6.0);
  });
});

describe("council parsing robustness", () => {
  it("ignores template echo and prose", () => {
    expect(parseObjections("icu", "OBJECTION\n AGAINST: [agent]\n SEVERITY: BLOCKER | CONCERN | NOTE")).toEqual([]);
    expect(parseObjections("icu", "I have no OBJECTION here.")).toEqual([]);
  });
  it("keeps a real BLOCKER", () => {
    const o = parseObjections("pharmacologist", "OBJECTION\n AGAINST: cardiologist\n REASON: QT combo\n SEVERITY: BLOCKER");
    expect(o.length).toBe(1);
    expect(o[0].severity).toBe("BLOCKER");
    expect(o[0].against).toBe("cardiologist");
  });
  it("matchSpecialty resolves and rejects", () => {
    const roster = ["icu", "cardiologist", "pharmacologist"];
    expect(matchSpecialty("the cardiologist's plan", roster)).toBe("cardiologist");
    expect(matchSpecialty("Dr. Mehta (ICU)", roster)).toBe("icu");
    expect(matchSpecialty("the plan", roster)).toBeNull();
    expect(matchSpecialty("unspecified", roster)).toBeNull();
  });
});

describe("getLabTrend zero-baseline + days clamp", () => {
  beforeEach(() => initDb());
  it("does not report 'rising' spuriously from a zero baseline", () => {
    const e1 = db.addTimelineEvent({ eventType: "lab_result", eventTimestamp: "2026-01-01T12:00:00Z", localTimestamp: "x", sourceType: "t", data: {} });
    db.addLabResult({ eventId: e1, testName: "crp", value: 0, collectionTime: "2026-01-01T12:00:00Z" });
    const e2 = db.addTimelineEvent({ eventType: "lab_result", eventTimestamp: "2026-01-02T12:00:00Z", localTimestamp: "x", sourceType: "t", data: {} });
    db.addLabResult({ eventId: e2, testName: "crp", value: 0, collectionTime: "2026-01-02T12:00:00Z" });
    expect(db.getLabTrend("crp").trend).toBe("stable"); // 0→0 is stable, not rising
  });
  it("getRecentTimeline tolerates an absurd days value", () => {
    expect(() => db.getRecentTimeline(1e15)).not.toThrow();
  });
});
