# MediConsult AI — TypeScript port (+ dev MCP connectors)

A TypeScript/Node replica of the Python MediConsult AI system: a single-patient
medical **decision-support** system where **Claude is the front-end via MCP**.
Local-first, PHI never leaves the device, ₹0 to run.

> **This variant** ships a project-scoped `.mcp.json` registering three dev-time
> MCP connectors (ponytail, Hermes Agent, supermemory) to assist development.
> They are **not** part of the app runtime and receive **no patient data** — see
> [`MCP_CONNECTORS.md`](MCP_CONNECTORS.md).

This is the **core spine** — the runnable foundation. Ingestion/OCR, the RAG
layer, the remote (mobile) server, and the formal MDT council are the documented
follow-ups (see [Deferred](#deferred-follow-ups)).

## Stack (Python → TypeScript)

| Concern | Python | TypeScript |
|---|---|---|
| MCP server | `mcp` / FastMCP | `@modelcontextprotocol/sdk` |
| Database | `sqlite3` | `better-sqlite3` (synchronous) |
| LLM routing | `litellm` | Vercel **AI SDK** (`ai` + `@ai-sdk/google`, `@ai-sdk/groq`, `@ai-sdk/openai-compatible`) |
| Local LLM | Ollama (litellm) | Ollama via its **OpenAI-compatible** endpoint (`/v1`) |
| Env / tests | dotenv / pytest | `dotenv` / `vitest` |
| Runtime | `py -3` | Node 20+, `tsx` (dev) / compiled `dist/` |

## What's built

```
src/
├── config.ts                 ✓ env load + data dir
├── db/
│   ├── schema.ts             ✓ better-sqlite3 schema (WAL, all tables)
│   ├── referenceData.ts      ✓ reference ranges + critical values + lab aliases
│   ├── clinicalUtils.ts      ✓ tz display + per-patient plausibility scoring
│   └── access.ts             ✓ all read/write data functions
├── agents/
│   ├── llmRouter.ts          ✓ circuit-breaker fallback: free tiers → local Ollama
│   ├── prompts.ts            ✓ 15 specialist prompts + WHO validator
│   └── council.ts            ✓ 15-agent MDT council + objection/BLOCKER protocol
├── rag/
│   ├── store.ts              ✓ sqlite-vec vector store + Ollama embeddings
│   └── knowledgeSeed.ts      ✓ seed guidelines + India drug facts
├── ingest/
│   ├── ocr.ts                ✓ text/PDF/docx + image OCR (graceful degrade)
│   ├── extract.ts            ✓ regex lab extraction (surfaces out-of-bounds)
│   ├── extractFull.ts        ✓ LLM full extraction (meds/diagnoses/labs)
│   ├── pipeline.ts           ✓ orchestrator: extract → score → route → alert
│   └── uploadApp.ts          ✓ caretaker upload page (drops into incoming/)
├── alerts/
│   └── delivery.ts           ✓ tiered alerts (ntfy) + critical-value checks
└── mcpServer/
    ├── tools.ts              ✓ shared MCP surface (resources + tools + prompt)
    ├── server.ts             ✓ local MCP server (stdio)
    ├── remoteServer.ts       ✓ remote MCP server (Streamable HTTP) + auth
    └── auth.ts               ✓ bearer tokens + role scoping + audit log
scripts/bootstrap.ts          ✓ init DB + placeholder patient
scripts/mintToken.ts          ✓ mint bearer tokens (owner/clinician/caretaker)
scripts/loadKnowledge.ts      ✓ index the seed knowledge into RAG
test/safety.test.ts           ✓ vitest: plausibility, timeline window, circuit breaker
test/auth.test.ts             ✓ vitest: token round-trip + role scoping
test/rag.test.ts              ✓ vitest: sqlite-vec index + retrieval + upsert
test/council.test.ts          ✓ vitest: objection parsing + BLOCKER escalation
test/ingest.test.ts           ✓ vitest: lab extraction + pipeline routing
test/upload.test.ts           ✓ vitest: caretaker role gate + sidecar write
```

All nine safety fixes from the Python codebase are carried over — notably #2/#8
(plausibility scoring returns 0.05 for out-of-bounds values, with an honest
reason string) and #5 (`getRecentTimeline` honours the `days` window).

**MCP surface (local, stdio):** resources `patient://record/summary`,
`patient://medications/active`, `patient://diagnoses/active`; tools
`get_lab_trend`, `get_active_medications`, `get_recent_timeline`,
`check_lab_value_safety`, `get_critical_alerts`, `get_pending_reviews`,
`run_specialist_review`, `run_full_mdt_consultation`, `llm_health`, `search_patient_history`,
`verify_against_guideline`, `check_drug_availability_india`, `confirm_review`, `ingest_document`, `ingest_incoming_folder`;
prompt `specialist_assessment`.

## Setup

```bash
# 1. Install deps (better-sqlite3 is native — needs a build toolchain / prebuilt)
npm install

# 2. Local Ollama fallback (never rate-limited) + embeddings for RAG
ollama pull meditron:7b
ollama pull qwen2.5:7b
ollama pull nomic-embed-text

# 3. Config
cp .env.example .env    # optionally add GOOGLE_API_KEY / GROQ_API_KEY / GITHUB_TOKEN

# 4. Create the database + a placeholder patient
npm run bootstrap

# 4b. Index the seed clinical knowledge into RAG (needs Ollama + nomic-embed-text)
npm run load:knowledge

# 5. Typecheck + tests
npm run typecheck
npm test

# 6. Start the MCP server (stdio)
npm start
```

> **Node version:** the DB + safety + MCP spine runs on **Node 20+** (verified on
> 20.18.1: typecheck clean, 8/8 tests pass). The Vercel AI SDK v7 emits an
> `EBADENGINE` warning preferring **Node 22+**, so for actual LLM calls
> (`run_specialist_review`) use Node 22+. `better-sqlite3` is pinned to **11.x** so
> its prebuilt binary works on Node 20 with no compiler (12.x only ships Node-22+
> prebuilts).

> **Behind a corporate TLS proxy?** If `npm install` fails with
> `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, trust your corporate root CA:
> 1. `powershell -File scripts\export-ca.ps1` → writes `%USERPROFILE%\corp-ca-bundle.pem`.
> 2. Create a (gitignored) `.npmrc` with `cafile=C:/Users/<you>/corp-ca-bundle.pem`.
> 3. For native prebuilt downloads, also expose it to Node:
>    `set NODE_EXTRA_CA_CERTS=%USERPROFILE%\corp-ca-bundle.pem`
>    (WSL: `export NODE_EXTRA_CA_CERTS='C:\Users\<you>\corp-ca-bundle.pem'; export WSLENV=NODE_EXTRA_CA_CERTS/w`).

## Connect to Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mediconsult-ts": {
      "command": "npx",
      "args": ["tsx", "/ABSOLUTE/PATH/mediconsult-ts/src/mcpServer/server.ts"],
      "env": {
        "MEDICONSULT_DATA": "/ABSOLUTE/PATH/patient_data",
        "GROQ_API_KEY": "your_key"
      }
    }
  }
}
```

For production, `npm run build` and point the connector at
`node dist/mcpServer/server.js` instead of `tsx`.

## Remote server (network access)

For a phone, claude.ai, or a remote Claude Code to reach a headless box, run the
Streamable-HTTP server. Every request is **bearer-authed, role-scoped, and
audit-logged**; anonymous access is refused (fail-closed).

```bash
# 1. Set a signing secret (once) → put it in .env as MEDICONSULT_AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# 2. Mint a token per person/device
npm run token owner            # or: clinician | caretaker

# 3. Start the server (default 0.0.0.0:8765, path /mcp)
npm run start:remote
```

Connect a client:

```bash
claude mcp add --transport http mediconsult https://your-host/mcp \
  --header "Authorization: Bearer <token>"
```

**Roles:** `owner` = all tools; `clinician` = read record + guidelines + specialist
review (no `confirm_review`); `caretaker` = timeline + critical alerts only. Put it
behind **Tailscale** or a **Cloudflare Tunnel** — never expose `:8765` directly.

## Caretaker upload page

A phone-friendly page for a family member / home nurse to send a photo or note —
no Claude, no tools. Uploads land in `incoming/` for `ingest_incoming_folder` to
process. Bearer-authed to the `caretaker` (or `owner`) role, size-capped.

```bash
npm run token caretaker        # mint a caretaker token
npm run start:upload           # serves http://0.0.0.0:8766/
```

The caretaker opens the page, pastes their token once (saved on-device), picks a
file, and sends. Put it behind Tailscale / Cloudflare like the remote server.

## Parity & scope

At **full feature parity** with the Python system: DB, safety scoring, resilient
router, 15 prompts, RAG, local + remote MCP with auth, the MDT council, document
ingestion, and the caretaker upload page. Everything from the Python system is
ported except Phase 6 (MONAI imaging), which is out of scope in both.

**Ingestion notes:** OCR uses `tesseract.js`. On a network that blocks the
default CDN language-data download, install `eng.traineddata` locally and set
`MEDICONSULT_TESSDATA` to that folder; without it, images route to human review
(never guessed). Digital PDFs (`pdfjs-dist`), `.docx` (`mammoth`), and text files
work with no download.

## Decision-support only

Every output informs the human treating physician, who retains all clinical
authority. Thresholds and clinical rules must be reviewed with the patient's
actual doctors before any clinical use.
```
