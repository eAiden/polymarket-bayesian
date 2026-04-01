// Append-only signal snapshot log — training data for the scoring model.
// Every analysis records the full signal + features + score for later training.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join } from "path";
import type { SignalSnapshot, ExtractedSignal, FeatureVector, ScoringResult } from "./types";
import { kvSet } from "./kv";

const DATA_DIR = join(process.cwd(), "data");
const LOG_FILE = join(DATA_DIR, "signal-log.json");

let idCounter = 0;

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `sig_${ts}_${rand}_${++idCounter}`;
}

export function loadSignalSnapshots(): SignalSnapshot[] {
  try {
    if (!existsSync(LOG_FILE)) return [];
    return JSON.parse(readFileSync(LOG_FILE, "utf-8")) as SignalSnapshot[];
  } catch {
    return [];
  }
}

export function appendSignalSnapshot(
  marketId: string,
  marketProbAtAnalysis: number,
  triggerType: SignalSnapshot["triggerType"],
  extractedSignal: ExtractedSignal,
  featureVector: FeatureVector,
  scoringResult: ScoringResult,
  modelVersion: string,
  baselineScore?: number,
): SignalSnapshot {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const snapshot: SignalSnapshot = {
    id: generateId(),
    marketId,
    timestamp: new Date().toISOString(),
    triggerType,
    marketProbAtAnalysis,
    extractedSignal,
    featureVector,
    scoringResult,
    modelVersion,
    resolved: false,
    ...(baselineScore !== undefined && { baselineScore }),
  };

  const existing = loadSignalSnapshots();
  existing.push(snapshot);

  // Atomic write
  const tmp = LOG_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(existing, null, 2), "utf-8");
  renameSync(tmp, LOG_FILE);
  kvSet("signal-log", existing);

  return snapshot;
}

// Called when a market resolves — backfill all snapshots for that market
export function markSnapshotsResolved(
  marketId: string,
  outcome: 1 | 0,
  resolvedAt: string,
  marketProbAtResolution: number,
): number {
  const snapshots = loadSignalSnapshots();
  let updated = 0;

  for (const s of snapshots) {
    if (s.marketId === marketId && !s.resolved) {
      s.resolved = true;
      s.outcome = outcome;
      s.resolvedAt = resolvedAt;
      s.marketProbAtResolution = marketProbAtResolution;
      updated++;
    }
  }

  if (updated > 0) {
    const tmp = LOG_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(snapshots, null, 2), "utf-8");
    renameSync(tmp, LOG_FILE);
    kvSet("signal-log", snapshots);
  }

  return updated;
}

// Get resolved snapshots with features — training data for the model
export function getTrainingData(): SignalSnapshot[] {
  return loadSignalSnapshots().filter(s => s.resolved && s.outcome !== undefined);
}
