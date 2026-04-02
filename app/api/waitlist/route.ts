// Waitlist signup — appends email + timestamp to data/waitlist.csv.
// Creates the file on first write if absent.
// No de-dup in v1 (acceptable for MVP).

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DATA_DIR = join(process.cwd(), "data");
const WAITLIST_FILE = join(DATA_DIR, "waitlist.csv");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  let email: string | undefined;

  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = await req.json();
      email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : undefined;
    } else {
      const form = await req.formData();
      const raw = form.get("email");
      email = typeof raw === "string" ? raw.trim().toLowerCase() : undefined;
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  const timestamp = new Date().toISOString();

  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    if (!existsSync(WAITLIST_FILE)) {
      appendFileSync(WAITLIST_FILE, "email,timestamp\n", "utf-8");
    }
    appendFileSync(WAITLIST_FILE, `${email},${timestamp}\n`, "utf-8");
  } catch (err) {
    console.error("[waitlist] Failed to write:", err);
    return NextResponse.json({ error: "Failed to save — try again" }, { status: 500 });
  }

  const accept = req.headers.get("accept") ?? "";
  if (!accept.includes("application/json")) {
    return NextResponse.redirect(new URL("/leaderboard?joined=1", req.url), 303);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
