import type { RawPMMarket, FilteredMarket, ScanError } from "./types";

const PM_BASE = "https://gamma-api.polymarket.com/markets";

// ─── Configurable filter thresholds ──────────────────────────────────────────
const MIN_YES_PCT = 10;
const MAX_YES_PCT = 90;
// Tightened from 90 → 45 to roughly halve time-to-training-data.
// Short-dated markets resolve faster, so we accumulate calibration samples 2x faster.
const MAX_DAYS = 45;
const MIN_VOLUME = 10_000;

function inferCategory(question: string): string {
  const q = question.toLowerCase();
  if (/\bbtc\b|bitcoin|\beth\b|ether(eum)?|\bcrypto|solana|\bsol\b|\bxrp\b|doge|defi|\bnft\b|blockchain|coinbase|binance|stablecoin|altcoin/.test(q)) return "Crypto";
  if (/elect|president|senate|congress|democrat|republican|trump|biden|harris|vance|nato|parliament|geopolit|prime minister|chancellor|\bpm\b|cabinet|impeach|coup|referendum|primary|gubernatorial|iran|israel|ukrain|russia|putin|zelensky|netanyahu|gaza|hamas|hezbollah|ceasefire|invasion|sanction|war\b|conflict|treaty|summit|tariff|deport|immigration/.test(q)) return "Politics";
  if (/\bnba\b|\bnfl\b|\bmlb\b|\bnhl\b|world cup|super bowl|playoff|champion|fifa|tennis|golf|ufc|olympic|premier league|la liga|bundesliga|serie a|champions league|europa league|uefa|formula 1|\bf1\b|masters|wimbledon|us open|grand slam|barcelona|real madrid|arsenal|chelsea|psg|liverpool|bayern|juventus|manchester|tottenham|atletico|inter milan|ac milan|sporting cp|aston villa|celtics|lakers|warriors|thunder|cowboys|patriots|chiefs|yankees|dodgers|messi|ronaldo|lebron|curry|mahomes|scheffler|mcilroy|djokovic/.test(q)) return "Sports";
  if (/\bfed\b|federal reserve|interest rate|inflation|\bgdp\b|recession|unemployment|\bcpi\b|\bpce\b|nasdaq|s&p|dow jones|stock market|\boil\b|crude|\bwti\b|brent|opec|gasoline|natural gas|gold|silver|copper|commodity|currency|dollar|\bforex\b|\beur\b|\byen\b|\byuan\b|bond|treasury|yield|earnings|ipo|merger|acquisition|bankruptcy|nvidia|tesla|apple|microsoft|google|amazon|meta|largest company/.test(q)) return "Economics";
  if (/\bai\b|artificial intelligence|openai|gpt|claude|anthropic|llm|spacex|starship|nasa|rocket|launch|climate|vaccine|\bfda\b|\bcdc\b|\bwho\b|pandemic|outbreak|earthquake|hurricane|tornado|wildfire|volcano|asteroid|eclipse/.test(q)) return "Science";
  if (/eurovision|oscar|grammy|emmy|tony award|cannes|sundance|box office|netflix|disney|marvel|taylor swift|drake|kendrick|beyonce|kardashian|grammy|album|movie|film|premiere/.test(q)) return "Entertainment";
  return "Other";
}

function formatVolume(n: number): string {
  if (!n || isNaN(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "—";
  }
}

async function fetchPage(offset: number): Promise<RawPMMarket[]> {
  const url = `${PM_BASE}?active=true&closed=false&limit=100&offset=${offset}&order=volumeNum&ascending=false`;
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ac.signal });
    if (!res.ok) throw new Error(`Polymarket API ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(tid);
  }
}

// Retry wrapper with exponential backoff
async function fetchPageWithRetry(offset: number, errors: ScanError[], retries = 2): Promise<RawPMMarket[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchPage(offset);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        const delay = attempt === 0 ? 1000 : 3000;
        console.warn(`[polymarket] Page offset=${offset} attempt ${attempt + 1} failed: ${msg}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`[polymarket] Page offset=${offset} failed after ${retries + 1} attempts: ${msg}`);
        errors.push({ source: "polymarket", message: `Page offset=${offset} failed: ${msg}`, timestamp: new Date().toISOString() });
        return [];
      }
    }
  }
  return [];
}

// Parse CLOB token IDs from JSON string
function parseClobTokenIds(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

// Process a single raw market into a FilteredMarket (or null if filtered out)
function processMarket(m: RawPMMarket, now: number): FilteredMarket | null {
  if (!m.active || m.closed) return null;
  try {
    const prices = JSON.parse(m.outcomePrices);
    const outcomes = JSON.parse(m.outcomes);
    if (!Array.isArray(prices) || prices.length !== 2) return null;
    if (!Array.isArray(outcomes) || outcomes.length !== 2) return null;

    const [o1, o2] = outcomes as string[];
    if (!["yes", "no"].includes(o1.toLowerCase()) || !["yes", "no"].includes(o2.toLowerCase())) return null;

    const yesIdx = o1.toLowerCase() === "yes" ? 0 : 1;
    const yesProbPct = Math.round(parseFloat(prices[yesIdx]) * 100);

    if (yesProbPct < MIN_YES_PCT || yesProbPct > MAX_YES_PCT) return null;

    const endIso = m.endDateIso ?? m.endDate;
    if (!endIso) return null;
    const endMs = new Date(endIso).getTime();
    const daysUntilResolution = Math.ceil((endMs - now) / 86_400_000);
    if (daysUntilResolution < 0 || daysUntilResolution > MAX_DAYS) return null;

    const volNum = m.volumeNum ?? parseFloat(m.volume ?? "0");
    if (volNum < MIN_VOLUME) return null;

    return {
      id: m.id,
      question: m.question,
      description: m.description?.slice(0, 500),
      resolutionSource: m.resolutionSource,
      url: m.events?.[0]?.slug ? `https://polymarket.com/event/${m.events[0].slug}` : undefined,
      category: inferCategory(m.question),
      yesProbPct,
      volume: formatVolume(volNum),
      endDate: formatDate(endIso),
      endDateIso: endIso,
      daysUntilResolution,
      clobTokenIds: parseClobTokenIds(m.clobTokenIds),
      bestBid: m.bestBid,
      bestAsk: m.bestAsk,
      spread: m.spread,
      lastTradePrice: m.lastTradePrice,
      volume24hr: m.volume24hr,
      liquidity: m.liquidity,
    };
  } catch {
    return null;
  }
}

export async function fetchFilteredMarkets(errors?: ScanError[]): Promise<FilteredMarket[]> {
  const now = Date.now();
  const scanErrors = errors ?? [];
  const results: FilteredMarket[] = [];

  // Fetch initial 5 pages (500 markets)
  const INITIAL_PAGES = 5;
  const initialOffsets = Array.from({ length: INITIAL_PAGES }, (_, i) => i * 100);
  const pages = await Promise.allSettled(initialOffsets.map(o => fetchPageWithRetry(o, scanErrors)));

  let lastPageQualifyCount = 0;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (page.status !== "fulfilled") continue;
    let pageQualified = 0;
    for (const m of page.value) {
      const filtered = processMarket(m, now);
      if (filtered) {
        results.push(filtered);
        pageQualified++;
      }
    }
    if (i === pages.length - 1) lastPageQualifyCount = pageQualified;
  }

  // Adaptive: if last page still had qualifying markets, fetch more
  if (lastPageQualifyCount > 0) {
    const MAX_EXTRA_PAGES = 3;
    for (let p = 0; p < MAX_EXTRA_PAGES; p++) {
      const offset = (INITIAL_PAGES + p) * 100;
      console.log(`[polymarket] Adaptive fetch: page offset=${offset} (last page had ${lastPageQualifyCount} qualifying)`);
      const extra = await fetchPageWithRetry(offset, scanErrors);
      if (extra.length === 0) break;

      let pageQualified = 0;
      for (const m of extra) {
        const filtered = processMarket(m, now);
        if (filtered) {
          results.push(filtered);
          pageQualified++;
        }
      }
      lastPageQualifyCount = pageQualified;
      if (pageQualified === 0) break; // no more qualifying markets at this volume tier
    }
  }

  console.log(`[polymarket] Total qualifying: ${results.length} markets`);

  // Deduplicate by ID
  const seen = new Set<string>();
  return results.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

// Fetch fresh YES price for a single market by ID
export async function fetchMarketPrice(id: string): Promise<number | null> {
  try {
    const res = await fetch(`${PM_BASE}?id=${id}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    const m = Array.isArray(data) ? data[0] : data;
    if (!m) return null;
    const prices = JSON.parse(m.outcomePrices);
    const outcomes = JSON.parse(m.outcomes);
    const yesIdx = (outcomes as string[])[0].toLowerCase() === "yes" ? 0 : 1;
    return Math.round(parseFloat(prices[yesIdx]) * 100);
  } catch {
    return null;
  }
}
