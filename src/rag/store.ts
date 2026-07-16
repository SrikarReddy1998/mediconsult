/**
 * MediConsult AI (TS) — RAG layer (sqlite-vec, in-process, no server).
 *
 * Per the RAG/MCP spec: RAG is used ONLY for external knowledge (guidelines,
 * drug data) and for targeted lookups in a large patient history. Whole-record
 * clinical reasoning uses FULL CONTEXT (db.buildFullPatientContext), not
 * retrieval — to avoid lost-in-the-middle and retrieval noise.
 *
 * Two collections (mirrors the Python ChromaDB store):
 *   - guidelines : WHO/NCCN/ESMO + India drug availability (external knowledge)
 *   - history    : semantic index of the patient's own documents (targeted lookup)
 *
 * Vectors: sqlite-vec (a loadable SQLite extension) in a local `rag.db`.
 * Embeddings: local Ollama via its OpenAI-compatible /v1/embeddings endpoint
 * (default model `nomic-embed-text`, 768-dim). The embedder is injectable so the
 * store is unit-testable without Ollama.
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.js";

const COLLECTIONS = ["guidelines", "history"] as const;
type Collection = (typeof COLLECTIONS)[number];

export interface RagHit {
  text: string;
  metadata: Record<string, any>;
  distance: number;
}

export type Embedder = (texts: string[]) => Promise<number[][]>;

/** Default embedder: local Ollama, OpenAI-compatible /v1/embeddings (batched). */
async function ollamaEmbed(texts: string[]): Promise<number[][]> {
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const model = process.env.MEDICONSULT_EMBED_MODEL ?? "nomic-embed-text";
  const res = await fetch(`${host}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`Ollama embeddings failed (${res.status}). Is Ollama running and '${model}' pulled? (ollama pull ${model})`);
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

export class RagStore {
  private db: Database.Database | null = null;
  private dim = 0;

  constructor(private embedder: Embedder = ollamaEmbed) {}

  private ragDbPath(): string {
    const base = dataDir();
    mkdirSync(base, { recursive: true });
    return join(base, "rag.db");
  }

  private conn(): Database.Database {
    if (this.db) return this.db;
    const db = new Database(this.ragDbPath());
    db.pragma("journal_mode = WAL");
    sqliteVec.load(db); // load the vector extension for this connection
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    for (const c of COLLECTIONS) {
      db.exec(`CREATE TABLE IF NOT EXISTS docs_${c} (
        rowid INTEGER PRIMARY KEY,
        doc_id TEXT UNIQUE NOT NULL,
        text TEXT NOT NULL,
        metadata TEXT
      )`);
    }
    const row = db.prepare("SELECT value FROM meta WHERE key = 'dim'").get() as { value: string } | undefined;
    if (row) this.dim = Number(row.value);
    this.db = db;
    return db;
  }

  /** Create the vec0 tables once the embedding dimension is known. */
  private ensureVecTables(dim: number): void {
    const db = this.conn();
    if (this.dim === 0) {
      for (const c of COLLECTIONS) {
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_${c} USING vec0(embedding float[${dim}])`);
      }
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('dim', ?)").run(String(dim));
      this.dim = dim;
    } else if (this.dim !== dim) {
      throw new Error(`Embedding dim ${dim} != index dim ${this.dim}. Changed MEDICONSULT_EMBED_MODEL? Delete rag.db to rebuild.`);
    }
  }

  private static toBlob(v: number[]): Buffer {
    return Buffer.from(new Float32Array(v).buffer);
  }

  private async add(collection: Collection, docId: string, text: string, metadata: Record<string, unknown>): Promise<void> {
    const [emb] = await this.embedder([text]);
    // A missing/empty embedding (e.g. Ollama returned data:[]) must not crash on
    // emb.length nor create a vec0(float[0]) table that poisons the index dim.
    if (!emb || emb.length === 0) {
      throw new Error("embedder returned an empty vector — is the embedding model available? (nothing indexed)");
    }
    this.ensureVecTables(emb.length);
    const db = this.conn();
    const blob = RagStore.toBlob(emb);
    const tx = db.transaction(() => {
      const existing = db.prepare(`SELECT rowid FROM docs_${collection} WHERE doc_id = ?`).get(docId) as { rowid: number } | undefined;
      let rowid: number;
      if (existing) {
        rowid = existing.rowid;
        db.prepare(`UPDATE docs_${collection} SET text = ?, metadata = ? WHERE rowid = ?`).run(text, JSON.stringify(metadata), rowid);
        db.prepare(`DELETE FROM vec_${collection} WHERE rowid = ?`).run(BigInt(rowid));
      } else {
        const info = db.prepare(`INSERT INTO docs_${collection}(doc_id, text, metadata) VALUES(?, ?, ?)`).run(docId, text, JSON.stringify(metadata));
        rowid = Number(info.lastInsertRowid);
      }
      // sqlite-vec's vec0 requires the rowid bound as a true int64 (BigInt).
      db.prepare(`INSERT INTO vec_${collection}(rowid, embedding) VALUES(?, ?)`).run(BigInt(rowid), blob);
    });
    tx();
  }

  private async search(collection: Collection, query: string, n: number): Promise<RagHit[]> {
    this.conn();
    if (this.dim === 0) return []; // nothing indexed yet
    const [q] = await this.embedder([query]);
    if (!q || q.length !== this.dim) return []; // wrong/empty query vector → no match, don't error
    const db = this.conn();
    const rows = db
      .prepare(
        `WITH knn AS (
           SELECT rowid, distance FROM vec_${collection}
           WHERE embedding MATCH ? ORDER BY distance LIMIT ?
         )
         SELECT d.text AS text, d.metadata AS metadata, knn.distance AS distance
         FROM knn JOIN docs_${collection} d ON d.rowid = knn.rowid
         ORDER BY knn.distance`,
      )
      .all(RagStore.toBlob(q), n) as { text: string; metadata: string | null; distance: number }[];
    return rows.map((r) => ({ text: r.text, metadata: r.metadata ? JSON.parse(r.metadata) : {}, distance: r.distance }));
  }

  // ── External knowledge (guidelines, drug data) ──
  addGuideline(docId: string, text: string, metadata: Record<string, unknown>): Promise<void> {
    return this.add("guidelines", docId, text, metadata);
  }
  searchGuidelines(query: string, n = 5): Promise<RagHit[]> {
    return this.search("guidelines", query, n);
  }

  // ── Patient history (targeted lookups in a large record) ──
  addHistoryChunk(docId: string, text: string, metadata: Record<string, unknown>): Promise<void> {
    return this.add("history", docId, text, metadata);
  }
  searchHistory(query: string, n = 5): Promise<RagHit[]> {
    return this.search("history", query, n);
  }
}

export const rag = new RagStore();
