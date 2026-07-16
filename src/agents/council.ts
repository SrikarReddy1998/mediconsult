/**
 * MediConsult AI (TS) — Formal MDT Council (Mode B).
 *
 * The full local multi-agent multidisciplinary consultation with the objection
 * protocol: specialists assess independently, raise formal objections to each
 * other, objections are resolved, and a consensus plan is synthesised — all
 * persisted to consultations + agent_outputs for audit.
 *
 * SAFETY (Python fix #1): an objection is only "resolved" if the accused
 * specialist actually ACCEPTED it. An unresolved BLOCKER prevents a consensus
 * plan and escalates to the human physician instead.
 *
 * Every LLM call goes through the resilient router (free tiers → local Ollama).
 * The agent-call function is injectable so the objection/escalation logic can be
 * unit-tested deterministically without an LLM.
 */
import * as db from "../db/access.js";
import { router } from "./llmRouter.js";
import { getAgentPrompt } from "./prompts.js";
import { rag } from "../rag/store.js";

export const DEFAULT_ROSTER = ["icu", "oncologist", "cardiologist", "haematologist", "infectious_disease", "pharmacologist"];

export type Severity = "BLOCKER" | "CONCERN" | "NOTE";

export interface AgentTurn {
  agent: string;
  phase: string;
  text: string;
  modelUsed: string;
  degraded: boolean;
}

export interface Objection {
  raisedBy: string;
  against: string;
  text: string;
  severity: Severity;
  resolved: boolean;
  resolution: string;
}

export interface ConsultationResult {
  consultation_id: number;
  roster: string[];
  turn_count: number;
  objections: Objection[];
  unresolved_blockers: number;
  consensus: string;
  degraded_to_local: boolean;
}

export type AskFn = (specialty: string, phase: string, task: string, extraContext?: string) => Promise<AgentTurn>;

export interface RunOptions {
  roster?: string[];
  trigger?: string;
  ask?: AskFn; // injectable for tests; defaults to the router-backed agent call
}

// ── Parsing helpers (pure, unit-testable) ──────────────────────────────────

export function field(block: string, label: string): string {
  const m = block.match(new RegExp(`${label}\\s*:?\\s*(.+)`));
  return m ? m[1].split("\n")[0].trim() : "";
}

/** Extract any REAL OBJECTION blocks an agent emitted.
 *
 * Guards against two false positives that otherwise fabricate objections (and,
 * worst case, a phantom BLOCKER that halts the whole consultation):
 *   - the prompt's OBJECTION *template* echoed back (its SEVERITY line is the
 *     menu "BLOCKER | CONCERN | NOTE" and its fields are "[placeholders]"),
 *   - prose that merely contains the word "OBJECTION" ("I have no OBJECTION").
 */
export function parseObjections(agent: string, text: string): Objection[] {
  const objs: Objection[] = [];
  const blocks = text.split(/\bOBJECTION\b/).slice(1);
  for (const block of blocks) {
    const against = field(block, "AGAINST");
    const sevRaw = field(block, "SEVERITY");
    if (sevRaw.includes("|")) continue; // the SEVERITY menu itself → template echo
    const hasTarget = !!against && !against.startsWith("[") && !against.toLowerCase().includes("unspecified");
    const hasSeverity = !!sevRaw;
    if (!hasTarget && !hasSeverity) continue; // bare prose mention of "objection"
    const reason = field(block, "REASON") || block.slice(0, 200).trim();
    if (reason.startsWith("[")) continue; // placeholder template text
    const sev = sevRaw.toUpperCase();
    const severity: Severity = (["BLOCKER", "CONCERN", "NOTE"] as const).find((s) => sev.includes(s)) ?? "CONCERN";
    objs.push({ raisedBy: agent, against: hasTarget ? against : "unspecified", text: reason.trim().slice(0, 500), severity, resolved: false, resolution: "" });
  }
  return objs;
}

/** Resolve a free-form objection target to a real roster specialty key, or null
 * (so a targetless/unknown BLOCKER stays unresolved and correctly escalates,
 * rather than being "resolved" by a non-existent agent). */
export function matchSpecialty(against: string, roster: string[]): string | null {
  if (!against || against.trim().toLowerCase() === "unspecified") return null;
  const a = against.toLowerCase();
  for (const key of roster) if (a.includes(key) || key.includes(a)) return key;
  return null;
}

/**
 * True only if the accused specialist clearly ACCEPTED (agreed to change).
 * Conservative: an explicit MAINTAINED verdict, or any ambiguity, counts as NOT
 * resolved — a disputed BLOCKER must escalate to the human rather than be
 * silently treated as settled. (Python fix #1.)
 */
export function resolutionAccepted(text: string): boolean {
  const m = text.match(/RESOLUTION\s*:?\s*(ACCEPTED|MAINTAINED|REJECTED)/i);
  if (m) return m[1].toUpperCase() === "ACCEPTED";
  const low = text.toLowerCase();
  const maintained = ["i maintain", "i stand by", "i justify", "i disagree", "no change", "i defend", "stand by my recommendation"];
  const accepted = ["i accept", "i will change", "i will modify", "i agree", "will adjust", "i concede", "accept the objection"];
  if (maintained.some((k) => low.includes(k))) return false;
  if (accepted.some((k) => low.includes(k))) return true;
  return false; // ambiguous → unresolved → escalate (safe default)
}

// ── Agent turn + evidence ──────────────────────────────────────────────────

async function defaultAsk(specialty: string, phase: string, task: string, extraContext = ""): Promise<AgentTurn> {
  const system = getAgentPrompt(specialty) ?? `You are a ${specialty}.`;
  const patientCtx = db.buildFullPatientContext();
  const user = `PATIENT RECORD:\n${patientCtx}\n\n${extraContext}\n\nTASK FOR THIS PHASE (${phase}):\n${task}`;
  const result = await router.complete(system, user);
  return { agent: specialty, phase, text: result.text, modelUsed: result.modelUsed, degraded: result.degraded };
}

/** Pull guideline/drug evidence relevant to this patient for the agents. */
async function relevantGuidelines(): Promise<string> {
  const dx = db.getActiveDiagnoses();
  const queries = dx.length ? dx.map((d) => d.diagnosis_name as string) : ["critical illness management"];
  const chunks: string[] = [];
  try {
    for (const q of queries.slice(0, 3)) {
      for (const hit of await rag.searchGuidelines(q, 2)) {
        chunks.push(`- ${hit.metadata.title}: ${String(hit.text).slice(0, 200)}`);
      }
    }
  } catch {
    /* RAG unavailable (e.g. Ollama down) — proceed without injected evidence */
  }
  return chunks.length ? "RELEVANT GUIDELINE EVIDENCE (retrieved):\n" + chunks.join("\n") : "";
}

// ── The consultation ────────────────────────────────────────────────────────

export async function runConsultation(opts: RunOptions = {}): Promise<ConsultationResult> {
  const roster = opts.roster && opts.roster.length ? opts.roster : DEFAULT_ROSTER;
  const trigger = opts.trigger ?? "manual";
  const ask = opts.ask ?? defaultAsk;

  const consultId = db.createConsultation(trigger);
  const turns: AgentTurn[] = [];
  const objections: Objection[] = [];
  let degradedAny = false;
  const record = (t: AgentTurn, type: string) => {
    turns.push(t);
    degradedAny ||= t.degraded;
    db.addAgentOutput(consultId, t, type);
  };

  const evidence = await relevantGuidelines();

  // ── PHASE 1: independent assessment ──
  for (const specialty of roster) {
    record(
      await ask(specialty, "assessment", "Give your independent assessment of this patient within your domain. State key findings, recommendations (with confidence and evidence), and any data gaps.", evidence),
      "assessment",
    );
  }

  // ── PHASE 2: objection round ──
  const assessments = turns.map((t) => `${t.agent.toUpperCase()} ASSESSMENT:\n${t.text}`).join("\n\n");
  for (const specialty of roster) {
    const turn = await ask(
      specialty,
      "objection",
      "Review the other specialists' assessments below. If any recommendation within YOUR domain is unsafe or sub-optimal, raise a formal OBJECTION using the exact OBJECTION format. If you have none, reply 'NO OBJECTIONS'.",
      "OTHER ASSESSMENTS:\n" + assessments,
    );
    record(turn, "objection");
    objections.push(...parseObjections(specialty, turn.text));
  }

  // ── PHASE 3: objection resolution ──
  for (const obj of objections) {
    const target = matchSpecialty(obj.against, roster);
    if (target) {
      const turn = await ask(
        target,
        "resolution",
        `Another specialist raised this objection to your recommendation:\n\n` +
          `OBJECTION (${obj.severity}) from ${obj.raisedBy}: ${obj.text}\n\n` +
          `Decide: either ACCEPT the objection and change your recommendation, or MAINTAIN it with explicit, evidence-based justification.\n` +
          `Begin your reply with EXACTLY one of these two lines:\n` +
          `  RESOLUTION: ACCEPTED   (you are changing your recommendation)\n` +
          `  RESOLUTION: MAINTAINED (you stand by it — then justify)\n` +
          `Then give your reasoning.`,
      );
      record(turn, "resolution");
      obj.resolved = resolutionAccepted(turn.text); // fix #1: only ACCEPTED clears it
      obj.resolution = turn.text.slice(0, 500);
    }
  }

  // ── PHASE 4: consensus synthesis (ICU orchestrator) ──
  const blockers = objections.filter((o) => o.severity === "BLOCKER" && !o.resolved);
  const consensusTask = blockers.length
    ? "There are UNRESOLVED BLOCKER objections. Do NOT write a final plan. Instead, summarise the unresolved conflicts and escalate them to the human treating physician for arbitration, stating what decision is needed from them."
    : "Synthesise the FINAL CONSENSUS CARE PLAN. Address every objection raised. Give immediate priorities, 24h/72h/7-day goals, a medication list with organ-adjusted doses, a monitoring plan, and an honest prognosis. Note where any recommendation depends on a value still pending human review.\n\nFULL DISCUSSION:\n" +
      turns.map((t) => `${t.agent} [${t.phase}]: ${t.text}`).join("\n\n").slice(0, 6000);

  const consensusTurn = await ask("icu", "consensus", consensusTask, evidence);
  record(consensusTurn, "consensus");

  db.completeConsultation(consultId, consensusTurn.text, objections.length);

  return {
    consultation_id: consultId,
    roster,
    turn_count: turns.length,
    objections,
    unresolved_blockers: blockers.length,
    consensus: consensusTurn.text,
    degraded_to_local: degradedAny,
  };
}
