// Near-duplicate observation titles. Ported from claude-mem's src/services/dedup (Apache-2.0):
//  - Tier 0 "exact": equal titles after normalization (case, punctuation, whitespace) -> safe to merge.
//  - Tier 1 "candidate": IDF-weighted cosine >= threshold and no rare token on only one side
//    (e.g. `example-api` vs `example-plugin`) -> recorded for review, never merged.

export const COSINE_THRESHOLD = 0.8;
/** A token appearing in at most this many titles is "discriminating" and vetoes a candidate. */
export const VETO_DF = 10;
/** Short titles make cosine jumpy; require this many shared tokens first. */
export const MIN_SHARED_TOKENS = 2;

/** Lowercase, non-alphanumerics (Unicode-aware) to spaces, collapse runs. '' means "never matches". */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Whitespace-only split, so compound identifiers (`example_diff.py`, `acme-web`) stay one rare token. */
export function tokenize(title: string): string[] {
  return title.toLowerCase().trim().split(/\s+/).filter(Boolean);
}

/** Smoothed IDF; finite and maximal for unseen tokens. */
export function idf(df: number, docs: number): number {
  return Math.log(1 + docs / (df + 0.5));
}

/** Document frequencies over a set of titles, for idf(). */
export class TitleCorpus {
  private readonly df = new Map<string, number>();
  docs = 0;

  constructor(titles: Iterable<string> = []) {
    for (const title of titles) this.add(title);
  }

  add(title: string): void {
    this.docs++;
    for (const token of new Set(tokenize(title))) this.df.set(token, (this.df.get(token) ?? 0) + 1);
  }

  idf(token: string): number {
    return idf(this.df.get(token) ?? 0, this.docs);
  }
}

function cosine(a: Set<string>, b: Set<string>, weight: (t: string) => number): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const t of a) {
    const w = weight(t);
    normA += w * w;
    if (b.has(t)) dot += w * w;
  }
  for (const t of b) normB += weight(t) ** 2;
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

export type DuplicateTier = 'exact' | 'candidate' | 'none';

export function classifyTitles(a: string, b: string, corpus: TitleCorpus): { tier: DuplicateTier; score: number } {
  const normA = normalizeTitle(a);
  if (normA !== '' && normA === normalizeTitle(b)) return { tier: 'exact', score: 1 };
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  if (shared < MIN_SHARED_TOKENS) return { tier: 'none', score: 0 };
  const weight = (t: string) => corpus.idf(t);
  const score = cosine(ta, tb, weight);
  const vetoIdf = idf(VETO_DF, corpus.docs);
  const vetoed = [...ta].some((t) => !tb.has(t) && weight(t) > vetoIdf) || [...tb].some((t) => !ta.has(t) && weight(t) > vetoIdf);
  return { tier: score >= COSINE_THRESHOLD && !vetoed ? 'candidate' : 'none', score };
}
