/**
 * MediConsult AI (TS) — caretaker upload tests.
 *
 * Role gate, filename sanitisation, and sidecar writing are pure/file-only, so
 * they run without starting the HTTP server (the server's main() is guarded to
 * run only when executed directly).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(() => {
  process.env.MEDICONSULT_DATA = mkdtempSync(join(tmpdir(), "medi-upload-"));
});

import { saveUpload, canUpload, safeName } from "../src/ingest/uploadApp.js";

describe("caretaker upload", () => {
  it("gates roles: caretaker + owner allowed; clinician/anon denied", () => {
    expect(canUpload("caretaker")).toBe(true);
    expect(canUpload("owner")).toBe(true);
    expect(canUpload("clinician")).toBe(false);
    expect(canUpload(null)).toBe(false);
  });

  it("sanitises filenames (strips path traversal + unsafe chars)", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(/[^A-Za-z0-9._-]/.test(safeName("mum's report (1).jpg"))).toBe(false);
  });

  it("saves the file + a metadata sidecar into incoming/", async () => {
    const { storedAs, path } = await saveUpload(Buffer.from("hello world"), {
      filename: "report.jpg",
      caption: "arm swollen since morning",
      capturedAt: "2026-07-13T10:00:00Z",
      contentType: "image/jpeg",
      role: "caretaker",
    });
    expect(existsSync(path)).toBe(true);
    expect(storedAs.endsWith("report.jpg")).toBe(true);
    const meta = JSON.parse(readFileSync(path + ".meta.json", "utf8"));
    expect(meta.caption).toBe("arm swollen since morning");
    expect(meta.uploaded_by_role).toBe("caretaker");
    expect(meta.original_filename).toBe("report.jpg");
  });
});
