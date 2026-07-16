/**
 * MediConsult AI (TS) — MDT council tests.
 *
 * The objection parser + BLOCKER-escalation rule (Python fix #1) are the
 * safety-critical logic. Verified deterministically with a scripted `ask` — no
 * LLM required. The full consultation over Ollama is a runtime step.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(() => {
  process.env.MEDICONSULT_DATA = mkdtempSync(join(tmpdir(), "medi-council-"));
});

import { initDb } from "../src/db/schema.js";
import { runConsultation, parseObjections, resolutionAccepted, type AskFn, type AgentTurn } from "../src/agents/council.js";

function turn(agent: string, phase: string, text: string): AgentTurn {
  return { agent, phase, text, modelUsed: "fake", degraded: false };
}

describe("council parsing (fix #1 core, pure)", () => {
  it("parses an OBJECTION block with target + severity", () => {
    const objs = parseObjections("pharmacologist", "OBJECTION\nAGAINST: cardiologist\nREASON: contraindicated combo\nSEVERITY: BLOCKER");
    expect(objs.length).toBe(1);
    expect(objs[0].against).toBe("cardiologist");
    expect(objs[0].severity).toBe("BLOCKER");
  });

  it("resolutionAccepted: ACCEPTED → true, MAINTAINED/ambiguous → false", () => {
    expect(resolutionAccepted("RESOLUTION: ACCEPTED\nI will change the dose.")).toBe(true);
    expect(resolutionAccepted("RESOLUTION: MAINTAINED\nI stand by it.")).toBe(false);
    expect(resolutionAccepted("some ambiguous reply")).toBe(false);
  });
});

describe("council BLOCKER escalation (fix #1 end-to-end, scripted ask)", () => {
  beforeEach(() => initDb());

  function scriptedAsk(resolutionText: string): { ask: AskFn; calls: { phase: string; task: string }[] } {
    const calls: { phase: string; task: string }[] = [];
    const ask: AskFn = async (specialty, phase, task) => {
      calls.push({ phase, task });
      if (phase === "objection" && specialty === "pharmacologist")
        return turn(specialty, phase, "OBJECTION\nAGAINST: cardiologist\nREASON: QT-prolonging combo\nSEVERITY: BLOCKER");
      if (phase === "objection") return turn(specialty, phase, "NO OBJECTIONS");
      if (phase === "resolution") return turn(specialty, phase, resolutionText);
      if (phase === "consensus") return turn(specialty, phase, "CONSENSUS-OUTPUT");
      return turn(specialty, phase, `${phase} text`);
    };
    return { ask, calls };
  }

  it("unresolved BLOCKER (MAINTAINED) → escalates, no consensus plan", async () => {
    const { ask, calls } = scriptedAsk("RESOLUTION: MAINTAINED\nI stand by it because the evidence supports it.");
    const res = await runConsultation({ roster: ["icu", "cardiologist", "pharmacologist"], ask });
    expect(res.unresolved_blockers).toBe(1);
    const consensus = calls.find((c) => c.phase === "consensus");
    expect(consensus?.task).toMatch(/UNRESOLVED BLOCKER|escalate/i);
  });

  it("accepted BLOCKER → consensus plan synthesised", async () => {
    const { ask, calls } = scriptedAsk("RESOLUTION: ACCEPTED\nI will change my recommendation.");
    const res = await runConsultation({ roster: ["icu", "cardiologist", "pharmacologist"], ask });
    expect(res.unresolved_blockers).toBe(0);
    const consensus = calls.find((c) => c.phase === "consensus");
    expect(consensus?.task).toMatch(/FINAL CONSENSUS CARE PLAN/i);
    expect(res.consensus).toBe("CONSENSUS-OUTPUT");
  });
});
