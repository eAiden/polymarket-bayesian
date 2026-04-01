// Waitlist signup — appends email + timestamp to data/waitlist.csv.
// Creates the file on first write if absent.
// No de-dup in v1 (acceptable for MVP).

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet, isKvConfigured } from "@/lib/kv";

export const dynamic = "force-dynamic";

const DATA_DIR = join(process.cwd(), "data");
const WAITLIST_FILE = join(DATA_DIR, "waitlist.csv");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  let email: string | undefined;

  // Accept both JSON body and form submission
  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = await req.json();
      email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : undefined;
    } else {
      // application/x-www-form-urlencoded (plain HTML form)
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
  const entry = { email, timestamp };

  try {
    if (isKvConfigured()) {
      // KV path: store as a JSON list (Vercel / production)
      const existing = (await kvGet<typeof entry[]>("waitlist")) ?? [];
      if (!existing.some(e => e.email === email)) {
        kvSet("waitlist", [...existing, entry]);
      }
    } else {
      // File path: append to CSV (Railway / dev)
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      if (!existsSync(WAITLIST_FILE)) {
        appendFileSync(WAITLIST_FILE, "email,timestamp\n", "utf-8");
      }
      appendFileSync(WAITLIST_FILE, `${email},${timestamp}\n`, "utf-8");
    }
  } catch (err) {
    console.error("[waitlist] Failed to write:", err);
    return NextResponse.json({ error: "Failed to save — try again" }, { status: 500 });
  }

  // For plain form submissions, redirect back to leaderboard with success indicator
  const accept = req.headers.get("accept") ?? "";
  if (!accept.includes("application/json")) {
    return NextResponse.redirect(new URL("/leaderboard?joined=1", req.url), 303);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
