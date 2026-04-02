// Tracks resolved market outcomes vs Bayesian fair estimates.
// Computes Brier score: lower = better; 0.25 = random (always predict 50%); ~0.15 = good forecaster.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const CALIB_FILE = join(DATA_DIR, "calibration.json");

export interface CalibrationRecord {
  marketId: string;
  question: string;
  fairProb: number;      // Bayesian estimate at time of last scan (0-100)
  marketProb: number;    // market price at resolution
  outcome: 1 | 0;        // 1 = resolved YES, 0 = resolved NO
  resolvedAt: string;    // ISO datetime
  brierScore: number;    // (fairProb/100 - outcome)²  — per-market score
  direction: "YES" | "NO"; // which side we said to buy
  directionCorrect: boolean; // was our buy direction right?
}

export interface CalibrationSummary {
  totalResolved: number;
  brierScore: number;       // mean Brier score (lower = better)
  brierBaseline: number;    // 0.25 = always predict 50% (random)
  brierSkill: number;       // (baseline - score) / baseline → skill % above random
  hitRate: number;          // % of markets where direction was correct
  records: CalibrationRecord[];
}

export function loadCalibrationRecords(): CalibrationRecord[] {
  try {
    if (!existsSync(CALIB_FILE)) return [];
    return JSON.parse(readFileSync(CALIB_FILE, "utf-8")) as CalibrationRecord[];
  } catch {
    return [];
  }
}

export function appendCalibrationRecord(record: CalibrationRecord): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const existing = loadCalibrationRecords();
    // Avoid duplicates — check by marketId (one record per market resolution)
    if (existing.some((r) => r.marketId === record.marketId)) return;
    existing.push(record);
    // Atomic write: write to .tmp then rename
    const tmp = CALIB_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(existing, null, 2), "utf-8");
    renameSync(tmp, CALIB_FILE);
  } catch (err) {
    console.error("[calibration] Failed to save record:", err);
  }
}

export function computeSummary(records: CalibrationRecord[]): CalibrationSummary {
  if (records.length === 0) {
    return {
      totalResolved: 0,
      brierScore: 0,
      brierBaseline: 0.25,
      brierSkill: 0,
      hitRate: 0,
      records: [],
    };
  }
  const brierScore = records.reduce((s, r) => s + r.brierScore, 0) / records.length;
  const hitRate = records.filter((r) => r.directionCorrect).length / records.length;
  const brierBaseline = 0.25;
  const brierSkill = Math.max(0, (brierBaseline - brierScore) / brierBaseline);

  return {
    totalResolved: records.length,
    brierScore: Math.round(brierScore * 1000) / 1000,
    brierBaseline,
    brierSkill: Math.round(brierSkill * 1000) / 1000,
    hitRate: Math.round(hitRate * 1000) / 1000,
    records,
  };
}

// Compute category-level bias from historical records.
// Returns how much the model over/under-estimates edge for a given category.
export function computeCategoryBias(records: CalibrationRecord[], category: string): {
  category: string;
  avgEdgeBias: number;
  sampleSize: number;
  message: string;
} | null {
  // We need the category stored per record — derive from question text using same regex as polymarket.ts
  const catRecords = records.filter(r => inferCategoryFromQuestion(r.question) === category);
  if (catRecords.length < 3) return null; // not enough data

  // Bias = mean(predicted_fair - actual_outcome_as_pct)
  // If bias > 0, model overestimates YES probability
  const biases = catRecords.map(r => {
    const actualPct = r.outcome * 100; // 0 or 100
    return r.fairProb - actualPct;
  });
  const avgBias = biases.reduce((s, b) => s + b, 0) / biases.length;

  const direction = avgBias > 0 ? "overestimates YES" : "underestimates YES";
  const message = `Historical calibration (${catRecords.length} ${category} markets): model ${direction} by ${Math.abs(Math.round(avgBias))}pp on average. Consider adjusting toward market price.`;

  return {
    category,
    avgEdgeBias: Math.round(avgBias * 10) / 10,
    sampleSize: catRecords.length,
    message,
  };
}

function inferCategoryFromQuestion(question: string): string {
  const q = question.toLowerCase();
  if (/btc|bitcoin|ether|crypto|solana|defi|nft|blockchain|coinbase|binance/.test(q)) return "Crypto";
  if (/elect|president|senate|congress|democrat|republican|trump|nato|parliament|geopolit|minister/.test(q)) return "Politics";
  if (/nba|nfl|mlb|nhl|world cup|super bowl|playoff|champion|fifa|tennis|golf|ufc|olympic/.test(q)) return "Sports";
  if (/\bfed\b|federal reserve|interest rate|inflation|gdp|recession|unemployment|cpi|pce|tariff|nasdaq|s&p/.test(q)) return "Economics";
  if (/\bai\b|artificial intelligence|openai|gpt|spacex|nasa|climate|vaccine|fda/.test(q)) return "Science";
  return "Other";
}

export function buildCalibrationRecord(
  marketId: string,
  question: string,
  fairProb: number,
  marketProb: number,
  outcome: 1 | 0,
  resolvedAt: string,
  direction: "YES" | "NO",
): CalibrationRecord {
  const brierScore = Math.pow(fairProb / 100 - outcome, 2);
  const directionCorrect =
    (direction === "YES" && outcome === 1) || (direction === "NO" && outcome === 0);
  return {
    marketId, question, fairProb, marketProb, outcome,
    resolvedAt, brierScore, direction, directionCorrect,
  };
}
