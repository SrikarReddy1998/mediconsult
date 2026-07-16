/**
 * MediConsult AI (TS) — regression tests for the safety-critical spine.
 *
 * Ports the Python safety tests that matter for this layer:
 *   #2/#8  plausibility scoring + honest reason string
 *   #5     get_recent_timeline honours the days window
 *   critical-value detection, lab-name normalisation, circuit breaker.
 *
 * No LLM or network required.  Run: npm test
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// db path is resolved from process.env at call time, so set a temp dir first.
beforeAll(() => {
  process.env.MEDICONSULT_DATA = mkdtempSync(join(tmpdir(), "medi-ts-"));
});

import * as db from "../src/db/access.js";
import { initDb } from "../src/db/schema.js";
import { scorePlausibility, isCritical } from "../src/db/clinicalUtils.js";
import { normaliseTestName } from "../src/db/referenceData.js";
import { ProviderCircuit, CircuitState } from "../src/agents/llmRouter.js";

describe("plausibility scoring (#2 / #8)", () => {
  it("flags an out-of-physiological-bounds value as an OCR error", () => {
    const [conf, reason] = scorePlausibility("potassium", 15.0, null, "F");
    expect(conf).toBe(0.05);
    expect(reason).toContain("outside physiological bounds");
  });

  it("accepts a within-range value with an accurate reason", () => {
    const [conf, reason] = scorePlausibility("potassium", 4.5, null, "F");
    expect(conf).toBe(0.92);
    expect(reason).toContain("within normal range");
  });

  it("accepts an abnormal-but-plausible value with an honest reason (#8)", () => {
    const [conf, reason] = scorePlausibility("potassium", 6.0, null, "F");
    expect(conf).toBe(0.92);
    expect(reason).toContain("outside the normal range");
  });

  it("provisionally accepts an unmapped test", () => {
    const [conf] = scorePlausibility(null, 123, null, null);
    expect(conf).toBe(0.7);
  });
});

describe("critical-value detection + normalisation", () => {
  it("detects a critical platelet value", () => {
    const [crit] = isCritical("platelets", 8.0);
    expect(crit).toBe(true);
  });

  it("normalises a lab alias to its canonical name", () => {
    expect(normaliseTestName("Hgb")).toBe("haemoglobin");
    expect(normaliseTestName("ferritin")).toBeNull();
  });
});

describe("get_recent_timeline honours the days window (#5)", () => {
  beforeAll(() => initDb());

  it("excludes events older than the window", () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    db.addTimelineEvent({ eventType: "lab_result", eventTimestamp: recent, localTimestamp: recent, sourceType: "test", data: { x: 1 }, summary: "recent-event" });
    db.addTimelineEvent({ eventType: "lab_result", eventTimestamp: old, localTimestamp: old, sourceType: "test", data: { x: 1 }, summary: "old-event" });

    const summaries = db.getRecentTimeline(7).map((e) => e.summary_text);
    expect(summaries).toContain("recent-event");
    expect(summaries).not.toContain("old-event");
  });
});

describe("router circuit breaker", () => {
  it("opens after the failure threshold and closes on success", () => {
    const c = new ProviderCircuit("test", 3, 120_000);
    expect(c.canAttempt()).toBe(true);
    c.recordFailure();
    c.recordFailure();
    c.recordFailure();
    expect(c.state).toBe(CircuitState.OPEN);
    expect(c.canAttempt()).toBe(false); // within cooldown
    c.recordSuccess();
    expect(c.state).toBe(CircuitState.CLOSED);
    expect(c.canAttempt()).toBe(true);
  });
});
