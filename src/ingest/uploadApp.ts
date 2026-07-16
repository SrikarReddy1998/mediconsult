/**
 * MediConsult AI (TS) — caretaker upload page.
 *
 * A mobile-friendly page for a family member / home nurse to send a photo or
 * document from their phone — no Claude, no MCP tools. It only DROPS files into
 * incoming/ (with a .meta.json sidecar); the ingestion pipeline
 * (ingest_incoming_folder) does the actual processing later. Bearer-authed to
 * the caretaker (or owner) role; every upload is capped and sanitised.
 *
 * Dependency-free: the page's JS POSTs the file as a raw body with metadata in
 * headers, so no multipart parser / extra package is needed.
 *
 * Run:  MEDICONSULT_AUTH_SECRET=... npm run start:upload
 * Token: npm run token caretaker
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadEnv, dataDir } from "../config.js";
loadEnv();
import { verifyToken } from "../mcpServer/auth.js";

const PORT = Number(process.env.MEDICONSULT_UPLOAD_PORT ?? 8766);
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_MB = Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024);

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function incomingDir(): string {
  const dir = join(dataDir(), "incoming");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function safeName(filename: string): string {
  const base = (filename || "upload").split(/[\\/]/).pop() ?? "upload";
  const cleaned = [...base].filter((c) => /[A-Za-z0-9._-]/.test(c)).join("");
  return cleaned || "upload";
}

/** Only caretakers (and the owner) may use the caretaker upload page. */
export function canUpload(role: string | null): boolean {
  return role === "caretaker" || role === "owner";
}

export interface UploadMeta {
  filename: string;
  caption: string;
  capturedAt: string;
  contentType: string;
  role: string;
}

/** Write the uploaded bytes + a metadata sidecar into incoming/. */
export async function saveUpload(bytes: Buffer, meta: UploadMeta): Promise<{ storedAs: string; path: string; receivedAt: string }> {
  const receivedAt = new Date().toISOString();
  const stamp = receivedAt.replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_"); // 20260713_195000
  const storedAs = `${stamp}_${safeName(meta.filename)}`;
  const dest = join(incomingDir(), storedAs);
  await writeFile(dest, bytes);
  await writeFile(
    dest + ".meta.json",
    JSON.stringify(
      {
        caption: meta.caption,
        captured_at_client: meta.capturedAt,
        received_at_server: receivedAt,
        uploaded_by_role: meta.role,
        original_filename: meta.filename,
        content_type: meta.contentType,
      },
      null,
      2,
    ),
  );
  return { storedAs, path: dest, receivedAt };
}

function roleFromAuth(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string" || !h.toLowerCase().startsWith("bearer ")) return null;
  const payload = verifyToken(h.slice(7).trim());
  return payload ? payload.role : null;
}

function readBodyCapped(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > cap) {
        req.destroy();
        reject(new HttpError(413, `File too large (max ${MAX_MB} MB).`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MediConsult — Send an update</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#222}
  h1{font-size:1.25rem} label{display:block;margin:14px 0 4px;font-weight:600}
  input[type=text],input[type=file]{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;box-sizing:border-box}
  button{margin-top:18px;width:100%;padding:14px;font-size:1rem;border:0;border-radius:8px;background:#0a7;color:#fff;font-weight:600}
  #status{display:none;margin-top:14px;font-weight:600}
  .hint{color:#666;font-size:.85rem;margin-top:2px}
</style></head><body>
<h1>Send an update to the care team</h1>
<p class="hint">Photo of a report, or a note about how things are going. Urgent findings alert the team automatically.</p>
<label for="file">Photo / document</label>
<input type="file" id="file" accept="image/*,application/pdf,.docx,.txt">
<label for="caption">What is this? (optional)</label>
<input type="text" id="caption" placeholder="e.g. Mum's arm looks more swollen since morning">
<label for="token">Caretaker token</label>
<input type="text" id="token" placeholder="Paste your caretaker token (saved after first use)">
<input type="hidden" id="captured">
<button onclick="send()">Send</button>
<div id="status"></div>
<script>
const $ = (id) => document.getElementById(id);
$('captured').value = new Date().toISOString();
const saved = localStorage.getItem('mc_token'); if (saved) $('token').value = saved;
function show(msg, ok){ const s=$('status'); s.textContent=msg; s.style.color= ok?'#0a7':'#c33'; s.style.display='block'; }
async function send(){
  const f = $('file').files[0];
  if(!f){ show('Please pick a file first.', false); return; }
  const token = $('token').value.trim();
  if(!token){ show('Please paste your caretaker token.', false); return; }
  localStorage.setItem('mc_token', token);
  try{
    const buf = await f.arrayBuffer();
    const r = await fetch('/upload', { method:'POST', headers:{
      'Authorization':'Bearer '+token,
      'Content-Type': f.type || 'application/octet-stream',
      'x-filename': encodeURIComponent(f.name),
      'x-caption': encodeURIComponent($('caption').value),
      'x-captured-at': encodeURIComponent($('captured').value)
    }, body: buf });
    const j = await r.json().catch(()=>({}));
    if(r.ok){ show('Sent. The care team will see this shortly.', true); $('file').value=''; $('caption').value=''; }
    else { show(j.detail || 'Upload failed.', false); }
  }catch(e){ show('Network error. Please try again.', false); }
}
</script>
</body></html>`;

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  if (req.method === "GET" && url === "/health") return sendJson(res, 200, { status: "ok" });

  if (req.method === "POST" && url === "/upload") {
    const role = roleFromAuth(req);
    if (!canUpload(role)) return sendJson(res, 401, { detail: "A valid caretaker token is required." });
    try {
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > MAX_UPLOAD_BYTES) return sendJson(res, 413, { detail: `File too large (max ${MAX_MB} MB).` });
      const bytes = await readBodyCapped(req, MAX_UPLOAD_BYTES);
      const hdr = (h: string) => {
        const v = req.headers[h];
        return typeof v === "string" ? decodeURIComponent(v) : "";
      };
      const saved = await saveUpload(bytes, {
        filename: hdr("x-filename") || "upload",
        caption: hdr("x-caption"),
        capturedAt: hdr("x-captured-at"),
        contentType: (req.headers["content-type"] as string) ?? "application/octet-stream",
        role: role as string,
      });
      return sendJson(res, 200, { status: "received", stored_as: saved.storedAs, received_at: saved.receivedAt, note: "Queued for processing. Urgent findings will alert the care team." });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 400;
      return sendJson(res, status, { detail: String((e as Error)?.message ?? e) });
    }
  }

  sendJson(res, 404, { detail: "not found" });
});

function main(): void {
  if (!process.env.MEDICONSULT_AUTH_SECRET) {
    console.error("ERROR: MEDICONSULT_AUTH_SECRET not set. Mint a caretaker token with `npm run token caretaker` after setting it.");
    process.exit(1);
  }
  server.listen(PORT, "0.0.0.0", () => {
    console.error(`MediConsult caretaker upload page on http://0.0.0.0:${PORT}/`);
    console.error("Put it behind Tailscale / Cloudflare. Uploads land in incoming/ for the ingest_incoming_folder tool.");
  });
}

// Start only when run directly (tsx), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
