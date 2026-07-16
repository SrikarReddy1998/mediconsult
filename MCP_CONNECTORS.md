# Dev MCP connectors

This variant of the TypeScript port ships a project-scoped **`.mcp.json`** that
registers three MCP servers so they're available to Claude Code **while working
in this repo**. They are **development assistants**, not part of the MediConsult
app's runtime.

> **Important — scope & privacy:** these three connectors help *build/maintain
> the code*. They are **NOT** wired into the MediConsult application, and **no
> patient data (PHI) is sent to them**. The app itself stays exactly as in the
> TypeScript port — self-contained, local-first (SQLite + sqlite-vec + Ollama).
> `.mcp.json` contains **no secrets** (supermemory uses OAuth), so it's safe to
> commit and share with the team.

## The three connectors

| Server | What it is | Role here |
|---|---|---|
| **ponytail** | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) — a "lazy senior dev" coding-rules MCP ("the best code is the code you never wrote") | Injects coding discipline/rules for Claude while editing this repo |
| **hermes** | [Hermes Agent (Nous Research)](https://hermes-agent.nousresearch.com) — an agent that also runs as an MCP server (`hermes mcp serve`), exposing conversation/session + messaging tools | Cross-session/messaging + session-history tools for the dev workflow |
| **supermemory** | [supermemory](https://supermemory.ai) hosted memory MCP (`https://mcp.supermemory.ai/mcp`) | Long-term memory/recall for the dev workflow across sessions |

## One-time setup (per machine)

`.mcp.json` is already committed. Each server needs its backend available:

**ponytail** — clone the repo and install its deps (defaults to `./vendor/ponytail`;
override with `PONYTAIL_DIR`):

```bash
git clone https://github.com/DietrichGebert/ponytail vendor/ponytail
cd vendor/ponytail/ponytail-mcp && npm install && cd ../../..
# optional: PONYTAIL_DEFAULT_MODE = lite | full | ultra  (set in .mcp.json env)
```

**hermes** — install the Hermes Agent framework, then configure a model:

```bash
# installs Python/Node/ripgrep/ffmpeg + a global `hermes` command
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
# OAuth + pick an LLM provider (needs a model with >= 64k context)
hermes setup --portal
```

The `.mcp.json` entry runs `hermes mcp serve` (stdio). Make sure `hermes` is on the
PATH that Claude Code uses to launch MCP servers — the installer is bash (installs
into WSL), so if Claude Code resolves commands on Windows you may need a Windows
install or an absolute path in `.mcp.json`.

**supermemory** — hosted and already live for this account (verified). First use
triggers OAuth in Claude Code if not already authorised. (Or install via
`npx -y install-mcp@latest https://mcp.supermemory.ai/mcp --client claude --oauth=yes`.)

## Verify

```bash
claude mcp list        # shows ponytail / hermes / supermemory and their status
# inside a Claude Code session:  /mcp
```

A connector showing as failed just means its backend isn't installed yet (e.g.
ponytail not cloned, or `hermes` not on PATH) — it does not affect the app or its
tests.

## The app itself

Everything under `src/` is the full MediConsult TypeScript port (DB, safety
scoring, resilient router, RAG, local + remote MCP servers, MDT council, document
ingestion, caretaker upload page). See `README.md`. Build/test as usual:

```bash
npm install && npm run typecheck && npm test
```
