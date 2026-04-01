// Shared keyword extraction for news scoring and cross-market matching.
// Only removes true function words (articles, prepositions, conjunctions).
// Keeps domain-meaningful verbs like "hit", "win", "reach" — these carry signal
// in prediction markets ("Will BTC HIT $100K", "Will Trump WIN").

const STOPWORDS = new Set([
  // Articles
  "the", "a", "an",
  // Prepositions
  "by", "in", "on", "at", "to", "for", "of", "from", "with", "into",
  // Conjunctions
  "and", "or", "but", "nor",
  // Auxiliaries
  "will", "be", "is", "are", "was", "were", "been",
  "have", "has", "had",
  "do", "does", "did",
  "can", "could", "would", "should", "may", "might", "shall",
  // Pronouns / determiners
  "this", "that", "these", "those", "it", "its",
  // Time words (too generic)
  "before", "after", "during", "until",
]);

/**
 * Extract meaningful keywords from a prediction market question.
 * Returns lowercased terms ≥2 chars that aren't function words.
 * Keeps verbs like "hit", "win", "reach", "exceed" — these are
 * directionally meaningful for market questions.
 */
export function extractKeywords(question: string, maxKeywords = 6): string[] {
  return question
    .replace(/[?!.,;:'"()\[\]{}]/g, "")
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, maxKeywords)
    .map(w => w.toLowerCase());
}

/**
 * Compute keyword overlap similarity between a title and a set of keywords.
 * Returns 0-1 (fraction of keywords found in the title).
 */
export function keywordSimilarity(title: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const lower = title.toLowerCase();
  const matches = keywords.filter(k => lower.includes(k)).length;
  return matches / keywords.length;
}
