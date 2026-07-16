/**
 * MediConsult AI (TS) — text extraction from documents.
 *
 * Plain text (fs), .docx (mammoth), digital PDF (pdfjs-dist), and images
 * (tesseract.js OCR). Every path DEGRADES GRACEFULLY: all heavy libs are
 * lazy-loaded inside try/catch, so a broken/uninstallable lib — or blocked
 * Tesseract language data — routes the file to human review instead of crashing
 * or guessing. Image "quality" is judged by OCR confidence (no native image lib).
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export interface OcrResult {
  text: string;
  engines_used: string[];
  ensemble_confidence: number; // 0..1
  verdict: "ok" | "degraded" | "poor";
  reason?: string;
  ocr_available?: boolean;
}

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"]);
const TEXT_EXTS = new Set([".txt", ".md", ".csv", ".text", ".log"]);

export const isPdf = (p: string) => extname(p).toLowerCase() === ".pdf";
export const isDocx = (p: string) => extname(p).toLowerCase() === ".docx";
export const isText = (p: string) => TEXT_EXTS.has(extname(p).toLowerCase());
export const isImage = (p: string) => IMAGE_EXTS.has(extname(p).toLowerCase());

const err = (e: unknown) => String((e as Error)?.message ?? e);

export async function extractTextFile(path: string): Promise<OcrResult> {
  const text = await readFile(path, "utf8");
  return { text, engines_used: ["text"], ensemble_confidence: 1.0, verdict: "ok" };
}

export async function extractDocxText(path: string): Promise<OcrResult> {
  try {
    const mod: any = await import("mammoth");
    const mammoth = mod.default ?? mod;
    const { value } = await mammoth.extractRawText({ buffer: await readFile(path) });
    return { text: value ?? "", engines_used: ["mammoth"], ensemble_confidence: 1.0, verdict: "ok" };
  } catch (e) {
    return { text: "", engines_used: [], ensemble_confidence: 0, verdict: "poor", reason: `docx extraction failed: ${err(e)}` };
  }
}

export async function extractPdfText(path: string): Promise<OcrResult> {
  try {
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(await readFile(path));
    const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: false }).promise;
    let text = "";
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      text += content.items.map((it: any) => (typeof it?.str === "string" ? it.str : "")).join(" ") + "\n";
    }
    text = text.trim();
    return text
      ? { text, engines_used: ["pdfjs"], ensemble_confidence: 0.95, verdict: "ok" }
      : { text: "", engines_used: ["pdfjs"], ensemble_confidence: 0, verdict: "poor", reason: "no embedded text (likely a scanned PDF — needs OCR or manual entry)" };
  } catch (e) {
    return { text: "", engines_used: [], ensemble_confidence: 0, verdict: "poor", reason: `pdf extraction failed: ${err(e)}` };
  }
}

const OCR_MIN_CONF = Number(process.env.MEDICONSULT_OCR_MIN_CONF ?? 55); // tesseract confidence 0..100

export async function runImageOcr(path: string): Promise<OcrResult> {
  try {
    const mod: any = await import("tesseract.js");
    const createWorker = (mod.default ?? mod).createWorker;
    // langPath: a local dir with eng.traineddata(.gz) enables OFFLINE OCR on a
    // network that blocks the default CDN download.
    const langPath = process.env.MEDICONSULT_TESSDATA;
    const worker = await createWorker("eng", 1, langPath ? { langPath, gzip: true } : {});
    try {
      const { data } = await worker.recognize(path);
      const conf: number = typeof data?.confidence === "number" ? data.confidence : 0;
      const verdict = conf < OCR_MIN_CONF ? "poor" : conf < 75 ? "degraded" : "ok";
      return {
        text: data?.text ?? "",
        engines_used: ["tesseract.js"],
        ensemble_confidence: Math.max(0, Math.min(1, conf / 100)),
        verdict,
        reason: verdict === "poor" ? `low OCR confidence (${conf.toFixed(0)}) — image likely blurry/unclear` : undefined,
        ocr_available: true,
      };
    } finally {
      await worker.terminate();
    }
  } catch (e) {
    // tesseract.js unavailable OR language data couldn't be fetched (e.g. blocked
    // network). Do NOT guess — signal unavailability so the pipeline routes to review.
    return {
      text: "",
      engines_used: [],
      ensemble_confidence: 0,
      verdict: "poor",
      ocr_available: false,
      reason: `OCR unavailable: ${err(e)}. Install language data + set MEDICONSULT_TESSDATA, or enter values manually.`,
    };
  }
}
