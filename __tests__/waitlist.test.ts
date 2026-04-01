// Tests for the waitlist API route logic.
// Tests email validation and CSV writing behavior using a temp directory.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, appendFileSync } from "fs";
import { join } from "path";

const TMP = join(process.cwd(), "__tests__", ".tmp-waitlist");

beforeEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
});

// Inline the waitlist write logic from the API route so we can test it
// without spinning up a Next.js server.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function writeWaitlist(email: string, dataDir: string): { ok: boolean; status: number; error?: string } {
  const file = join(dataDir, "waitlist.csv");

  if (!email || !EMAIL_RE.test(email)) {
    return { ok: false, status: 400, error: "Valid email required" };
  }

  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    if (!existsSync(file)) {
      appendFileSync(file, "email,timestamp\n", "utf-8");
    }
    appendFileSync(file, `${email},${new Date().toISOString()}\n`, "utf-8");
    return { ok: true, status: 200 };
  } catch (err) {
    return { ok: false, status: 500, error: "Failed to save" };
  }
}

describe("waitlist email validation", () => {
  it("accepts valid email", () => {
    const result = writeWaitlist("user@example.com", TMP);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("rejects empty string", () => {
    const result = writeWaitlist("", TMP);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("rejects email without @", () => {
    const result = writeWaitlist("notanemail", TMP);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("rejects email without domain", () => {
    const result = writeWaitlist("user@", TMP);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("rejects email without TLD", () => {
    const result = writeWaitlist("user@nodot", TMP);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });
});

describe("waitlist CSV writing", () => {
  it("creates file with header on first write", () => {
    const file = join(TMP, "waitlist.csv");
    expect(existsSync(file)).toBe(false);

    writeWaitlist("first@example.com", TMP);

    expect(existsSync(file)).toBe(true);
    const contents = readFileSync(file, "utf-8");
    expect(contents.startsWith("email,timestamp\n")).toBe(true);
    expect(contents).toContain("first@example.com");
  });

  it("appends without duplicating header on second write", () => {
    writeWaitlist("first@example.com", TMP);
    writeWaitlist("second@example.com", TMP);

    const contents = readFileSync(join(TMP, "waitlist.csv"), "utf-8");
    const lines = contents.trim().split("\n");
    // Header + 2 data rows
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("email,timestamp");
    expect(lines[1]).toContain("first@example.com");
    expect(lines[2]).toContain("second@example.com");
  });

  it("each CSV line has email and ISO timestamp", () => {
    writeWaitlist("check@example.com", TMP);
    const contents = readFileSync(join(TMP, "waitlist.csv"), "utf-8");
    const dataLine = contents.trim().split("\n")[1];
    const [email, ts] = dataLine.split(",");
    expect(email).toBe("check@example.com");
    expect(() => new Date(ts)).not.toThrow();
    expect(new Date(ts).getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it("multiple emails accumulate correctly", () => {
    const emails = ["a@x.com", "b@x.com", "c@x.com"];
    for (const e of emails) writeWaitlist(e, TMP);
    const contents = readFileSync(join(TMP, "waitlist.csv"), "utf-8");
    for (const e of emails) expect(contents).toContain(e);
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(4); // header + 3
  });
});
