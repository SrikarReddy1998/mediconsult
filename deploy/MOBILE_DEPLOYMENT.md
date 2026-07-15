# MediConsult AI — Mobile & Remote Deployment Guide (Phase 3.5)

This phase makes the system usable **from your phone**. The local server you
already have uses `stdio` transport, which only works when Claude Desktop can
launch a process on the same machine. A phone has no such machine — so mobile
requires a **remote** MCP server that Claude reaches over the internet.

## What got built in this phase

```
mediconsult/mcp_server/
├── auth.py              ✓ Bearer-token auth + role scoping (owner/clinician/caretaker)
└── remote_server.py     ✓ SSE-transport MCP server with auth on every tool call

mediconsult/ingest/
└── upload_app.py        ✓ Caretaker mobile upload page (photo/video/voice/PDF)

deploy/
├── Dockerfile           ✓ Container image for the remote services
├── docker-compose.remote.yml  ✓ MCP + upload + Ollama + Litestream backup
├── cloudflared_config.yml     ✓ Cloudflare Tunnel (no open ports)
└── litestream.yml             ✓ Continuous backup to Cloudflare R2
```

**Tested:** token issue/verify (tampered + expired rejected), role scoping
(caretaker correctly denied consultations and raw labs), upload-page auth.

## The architecture for mobile

```
   YOUR PHONE                          THE HOST (laptop or free Oracle ARM VM)
┌──────────────┐                      ┌────────────────────────────────────┐
│   Claude     │                      │  Cloudflare Tunnel (cloudflared)     │
│  (mobile app)│──── HTTPS ──────────►│   ↓ (no open ports on the host)      │
│              │   via Cloudflare     │  remote_server.py  :8765  (MCP/SSE)  │
│              │   Access (auth gate) │  upload_app.py     :8766  (caretaker)│
└──────────────┘                      │  ollama            :11434 (local LLM)│
                                       │  litestream → Cloudflare R2 (backup) │
   FAMILY PHONE                        │  patient.db  (the single record)     │
┌──────────────┐                      └────────────────────────────────────┘
│ upload page  │──── HTTPS ──────────────────────► (caretaker uploads)
│  (browser)   │
└──────────────┘
```

Two security layers, defence in depth:
1. **Cloudflare Access** — the network gate. Nothing reaches the host without
   passing Cloudflare's auth first. No ports are open on the machine.
2. **Bearer token + role scoping** — the app gate. Even if the network layer
   were misconfigured, the server refuses anonymous calls and enforces what
   each role may do.

## Setup, step by step (≈45 minutes, ₹0)

### 1. Get a host

Either your laptop (for testing) or the **free Oracle Cloud ARM VM** (4 CPU,
24GB RAM, permanently free) for always-on access. The VM is recommended so the
system is reachable even when your laptop is off.

### 2. Generate the auth secret and tokens

```bash
# One signing secret for the whole system
python -c "import secrets; print(secrets.token_urlsafe(32))"
# → put this in .env as MEDICONSULT_AUTH_SECRET

export MEDICONSULT_AUTH_SECRET=<that secret>

# One token per person/device:
python -m mediconsult.mcp_server.auth owner      # for you
python -m mediconsult.mcp_server.auth clinician  # for a treating doctor
python -m mediconsult.mcp_server.auth caretaker  # for a family member
```

### 3. Set free API keys

```bash
cp .env.example .env
# Fill in GOOGLE_API_KEY, GROQ_API_KEY, GITHUB_TOKEN (all free, no card)
# Add MEDICONSULT_AUTH_SECRET and the R2 backup keys
```

### 4. Start the stack

```bash
docker compose -f deploy/docker-compose.remote.yml up -d
docker exec -it $(docker ps -qf name=ollama) ollama pull meditron:7b
```

### 5. Set up the Cloudflare Tunnel (free)

```bash
cloudflared tunnel login
cloudflared tunnel create mediconsult
# edit deploy/cloudflared_config.yml with your tunnel UUID + domain
cloudflared tunnel route dns mediconsult mcp.yourdomain.com
cloudflared tunnel route dns mediconsult upload.yourdomain.com
cloudflared tunnel run mediconsult
```

Then in the Cloudflare dashboard → **Zero Trust → Access → Applications**, add
an Access policy for both hostnames (email one-time-PIN to your address, or
your identity provider). This is the network gate.

### 6. Connect from Claude mobile

In the Claude mobile app: **Settings → Connectors → Add custom connector**.
- URL: `https://mcp.yourdomain.com/sse`
- In Advanced settings, supply the bearer token (your owner token)

> **Enterprise plan note:** on Team/Enterprise plans, only an Owner or Primary
> Owner can add a custom connector for the organisation. If your Jio Enterprise
> admin won't approve it, add the connector under a personal Pro/Max account
> instead — the connector is independent of which account's data it reads.

### 7. Give family the upload link

Send caretakers `https://upload.yourdomain.com` and their caretaker token.
They paste the token once (the page remembers it on their device) and can then
send a photo/video/voice note in three taps. Submissions land in
`incoming/caretaker/` for the Phase 3 ingestion pipeline to process.

## Now you can, from your phone

> "Show me mum's platelet trend." → Claude calls the remote MCP tool, answers.
> "Any critical alerts right now?" → reads the alerts table.
> "Run an oncologist review on her current status." → free-tier → local fallback.

And family members, from any phone browser, can submit what they observe at
the bedside — with accurate timestamps — straight into the record.

## Security checklist before real use

- [ ] `MEDICONSULT_AUTH_SECRET` is a strong random value, never committed to git
- [ ] Cloudflare Access policy is active on both hostnames
- [ ] All host ports bound to `127.0.0.1` only (compose already does this)
- [ ] SQLCipher enabled for at-rest DB encryption (Phase 3 hardening)
- [ ] Litestream backup running and a test restore has succeeded
- [ ] Tokens issued per person; caretaker/clinician tokens cannot trigger consultations, ingest, or confirm_review (owner only)
- [ ] `mcp_audit.log` reviewed — every tool call is logged with role + decision

## What's still ahead

- **Phase 3** — the OCR ingestion pipeline that processes what lands in
  `incoming/` (including caretaker uploads), the human review queue, and alert
  delivery (ntfy/WhatsApp).
- **Phase 4** — populate the ChromaDB guideline + drug index.
- **Phase 5 (optional)** — the full local LangGraph + Ollama formal council.

## Honest note on running medical data through a tunnel

Exposing a server that holds a real medical record to the internet — even
behind Cloudflare Access — is a larger attack surface than the laptop-only
Tailscale setup. The mitigations above (network gate + app auth + role scoping
+ localhost-bound ports + audit log + encryption at rest) are real and layered,
but you are trading some safety for mobile convenience. If you only ever need
access from your own devices, the **Tailscale** option (laptop guide) keeps the
server invisible to the public internet entirely and is the more conservative
choice. Use the Cloudflare path when family members on their own phones must
reach the upload page.
