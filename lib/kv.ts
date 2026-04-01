// KV abstraction — Upstash Redis REST API in production, local JSON files in dev.
// No SDK needed: uses native fetch (Node 18+).
//
// Set in env:
//   UPSTASH_REDIS_REST_URL   = https://your-db.upstash.io
//   UPSTASH_REDIS_REST_TOKEN = your-token
//
// If those vars are absent, every kvGet returns null and kvSet is a no-op.
// Local dev continues using the existing file-based storage unchanged.

const KV_URL = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, "");
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export function isKvConfigured(): boolean {
  return !!(KV_URL && KV_TOKEN);
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function kvGet<T>(key: string): Promise<T | null> {
  if (!isKvConfigured()) return null;
  try {
    const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      // Skip Next.js cache — always want live data
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json() as { result: string | null };
    if (data.result == null) return null;
    return JSON.parse(data.result) as T;
  } catch {
    return null;
  }
}

// ─── Write (fire-and-forget — does not block callers) ─────────────────────────

export function kvSet(key: string, value: unknown): void {
  if (!isKvConfigured()) return;
  const encoded = JSON.stringify(value);
  fetch(`${KV_URL}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN!}`,
      "Content-Type": "application/json",
    },
    // Upstash pipeline-format: ["SET", key, value]
    body: JSON.stringify(["SET", key, encoded]),
  }).catch(err => console.warn(`[kv] set "${key}" failed:`, (err as Error).message));
}

// ─── Append to a capped JSON array ───────────────────────────────────────────
// Reads existing array from KV, appends item, writes back. Cap prevents unbounded growth.
// Note: not atomic — fine for our single-writer-per-key model.

export async function kvAppend<T>(key: string, item: T, cap = 500): Promise<void> {
  if (!isKvConfigured()) return;
  const existing = (await kvGet<T[]>(key)) ?? [];
  const next = [...existing, item].slice(-cap);
  kvSet(key, next);
}
