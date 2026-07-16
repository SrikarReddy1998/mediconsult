/**
 * MediConsult AI (TS) — resilient LLM router.
 *
 * The chain: primary free tier → fallback free tiers → LOCAL Ollama (never
 * rate-limited). A circuit breaker skips failing providers; exponential backoff
 * with jitter on rate limits. If every cloud tier is exhausted, local Ollama
 * keeps the system fully functional at zero cost.
 *
 * Built on the Vercel AI SDK (v7). Ollama is reached through its
 * OpenAI-compatible endpoint, so no exotic provider package is required.
 */
import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// Version-proof model type: exactly what generateText accepts.
type ModelArg = Parameters<typeof generateText>[0]["model"];

export enum CircuitState {
  CLOSED = "closed",
  OPEN = "open",
  HALF_OPEN = "half_open",
}

export class ProviderCircuit {
  state: CircuitState = CircuitState.CLOSED;
  failures = 0;
  private openedAt = 0;

  constructor(
    public readonly name: string,
    private readonly failureThreshold = 3,
    private readonly cooldownMs = 120_000,
  ) {}

  recordSuccess(): void {
    this.failures = 0;
    this.state = CircuitState.CLOSED;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.openedAt = Date.now();
    }
  }

  canAttempt(): boolean {
    if (this.state === CircuitState.CLOSED) return true;
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.openedAt > this.cooldownMs) {
        this.state = CircuitState.HALF_OPEN;
        return true;
      }
      return false;
    }
    return true; // HALF_OPEN → allow a probe
  }
}

interface ChainEntry {
  id: string;
  tier: "cloud-free" | "local";
  make: () => ModelArg | null; // null = not configured (e.g. no API key) → skip
}

function localModel(name: string): ModelArg {
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const ollama = createOpenAICompatible({ name: "ollama", baseURL: `${host}/v1`, apiKey: "ollama" });
  return ollama(name);
}

/** The fallback chain. Local Ollama is the unbreakable floor. */
export function defaultChain(): ChainEntry[] {
  const localMedical = process.env.MEDICONSULT_LOCAL_MEDICAL ?? "meditron:7b";
  const localGeneral = process.env.MEDICONSULT_LOCAL_GENERAL ?? "qwen2.5:7b";
  return [
    {
      id: "gemini/gemini-2.5-flash",
      tier: "cloud-free",
      make: () => (process.env.GOOGLE_API_KEY ? createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY })("gemini-2.5-flash") : null),
    },
    {
      id: "groq/llama-3.3-70b-versatile",
      tier: "cloud-free",
      make: () => (process.env.GROQ_API_KEY ? createGroq({ apiKey: process.env.GROQ_API_KEY })("llama-3.3-70b-versatile") : null),
    },
    {
      id: "github/gpt-4o",
      tier: "cloud-free",
      make: () =>
        process.env.GITHUB_TOKEN
          ? createOpenAICompatible({ name: "github", baseURL: "https://models.github.ai/inference", apiKey: process.env.GITHUB_TOKEN })("openai/gpt-4o")
          : null,
    },
    { id: `ollama/${localMedical}`, tier: "local", make: () => localModel(localMedical) }, // medical floor
    { id: `ollama/${localGeneral}`, tier: "local", make: () => localModel(localGeneral) }, // general floor
  ];
}

export function reasoningChain(): ChainEntry[] {
  const localReason = process.env.MEDICONSULT_LOCAL_REASON ?? "qwen2.5:7b";
  return [
    {
      id: "groq/llama-3.3-70b-versatile",
      tier: "cloud-free",
      make: () => (process.env.GROQ_API_KEY ? createGroq({ apiKey: process.env.GROQ_API_KEY })("llama-3.3-70b-versatile") : null),
    },
    {
      id: "gemini/gemini-2.5-pro",
      tier: "cloud-free",
      make: () => (process.env.GOOGLE_API_KEY ? createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY })("gemini-2.5-pro") : null),
    },
    { id: `ollama/${localReason}`, tier: "local", make: () => localModel(localReason) },
  ];
}

export class AllProvidersDownError extends Error {}

export interface CompleteResult {
  text: string;
  modelUsed: string;
  tier: string;
  wasFallback: boolean;
  degraded: boolean;
}

function isRateLimit(e: unknown): boolean {
  const msg = String((e as { message?: string })?.message ?? e).toLowerCase();
  return ["rate limit", "429", "quota", "exhaust", "overloaded", "529"].some((k) => msg.includes(k));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LLMRouter {
  private circuits = new Map<string, ProviderCircuit>();

  private circuit(id: string): ProviderCircuit {
    let c = this.circuits.get(id);
    if (!c) {
      c = new ProviderCircuit(id);
      this.circuits.set(id, c);
    }
    return c;
  }

  /** Raises AllProvidersDownError only if even local Ollama is unreachable. */
  async complete(system: string, user: string, chain: ChainEntry[] = defaultChain(), timeoutMs = Number(process.env.MEDICONSULT_LLM_TIMEOUT_MS ?? 30_000)): Promise<CompleteResult> {
    let lastError: unknown = null;

    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i];
      const circuit = this.circuit(entry.id);
      if (!circuit.canAttempt()) continue;

      // A provider factory that throws (malformed key/baseURL, or a future SDK
      // that validates eagerly) must be treated as a provider failure, NOT
      // escape the whole router and bypass the local-Ollama floor.
      let model: ModelArg | null;
      try {
        model = entry.make();
      } catch (e) {
        lastError = e;
        circuit.recordFailure();
        continue;
      }
      if (!model) continue; // provider not configured — skip without penalising it

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { text } = await generateText({
            model,
            system,
            prompt: user,
            maxOutputTokens: 1200,
            maxRetries: 0, // this router owns ret/fallback + circuit-breaking
            abortSignal: AbortSignal.timeout(timeoutMs),
          });
          circuit.recordSuccess();
          return { text, modelUsed: entry.id, tier: entry.tier, wasFallback: i > 0, degraded: entry.tier === "local" };
        } catch (e) {
          lastError = e;
          if (isRateLimit(e)) {
            await sleep(2 ** attempt * 1000 + Math.random() * 1000); // backoff + jitter
          } else {
            break; // non-retryable for this provider; move on
          }
        }
      }
      // Reached only when no attempt returned → this provider failed.
      circuit.recordFailure();
    }

    throw new AllProvidersDownError(
      "All LLM providers exhausted, including local Ollama. Agent reasoning is " +
        "temporarily unavailable. Data ingestion, the timeline, alerts, and the " +
        `database remain fully functional. Last error: ${String((lastError as { message?: string })?.message ?? lastError)}`,
    );
  }

  /** Health of each provider — surfaced via the MCP llm_health tool. */
  status(): Record<string, { state: string; failures: number }> {
    const out: Record<string, { state: string; failures: number }> = {};
    for (const [id, c] of this.circuits) out[id] = { state: c.state, failures: c.failures };
    return out;
  }
}

export const router = new LLMRouter();
