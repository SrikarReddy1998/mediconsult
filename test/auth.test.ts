/**
 * MediConsult AI (TS) — remote-server auth tests: token round-trip, tamper
 * rejection, and role scoping (mirrors the Python auth model / fix #4).
 */
import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.MEDICONSULT_AUTH_SECRET = "test-secret-value-32bytes-minimum!!";
});

import { issueToken, verifyToken, canCall } from "../src/mcpServer/auth.js";

describe("remote auth", () => {
  it("round-trips a valid token", () => {
    expect(verifyToken(issueToken("clinician"))?.role).toBe("clinician");
  });

  it("rejects garbage, tampered, and malformed tokens", () => {
    expect(verifyToken("garbage.token")).toBeNull();
    expect(verifyToken(issueToken("owner") + "x")).toBeNull(); // tampered signature
    expect(verifyToken("onlyonepart")).toBeNull();
  });

  it("enforces role scoping (owner-only actions; caretaker minimal)", () => {
    expect(canCall("owner", "confirm_review")).toBe(true);
    expect(canCall("clinician", "confirm_review")).toBe(false);
    expect(canCall("clinician", "get_lab_trend")).toBe(true);
    expect(canCall("caretaker", "run_specialist_review")).toBe(false);
    expect(canCall("caretaker", "get_recent_timeline")).toBe(true);
    expect(canCall("nobody", "get_lab_trend")).toBe(false);
  });
});
