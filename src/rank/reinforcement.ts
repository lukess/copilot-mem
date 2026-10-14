// SPDX-License-Identifier: Apache-2.0
// Adapted from claude-mem src/services/reinforcement/{strength,rank}.ts (Apache-2.0).

/**
 * ACT-R base-level activation over an observation's history: its occurrence is the first
 * "presentation" and each later day the compressor re-produced it is another. Something
 * re-confirmed yesterday stays strong even if it was first seen months ago.
 *
 *   score = ln(1 + age_occurred^-d + ALPHA * sum(age_reinforcement^-d))
 */

const MS_PER_DAY = 86_400_000;

/** Power-law decay exponent: age^-d. 0.5 is the canonical ACT-R value. */
export const ACT_R_DECAY = 0.5;
/** Reinforcement days kept per observation; older ones fall off FIFO. */
export const MAX_REINFORCEMENT_HISTORY = 10;
const ALPHA = 1;

export interface Rankable {
  occurred_at: string;
  /** Distinct `YYYY-MM-DD` days the observation was re-confirmed. */
  reinforcement_dates: string[];
}

/** Whole-day age of an ISO date or timestamp relative to `today`, at least 1. */
export function ageDays(iso: string, today: Date): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 1;
  return Math.max(1, Math.floor((today.getTime() - then) / MS_PER_DAY));
}

/** Tolerant parse of the JSON `reinforcement_dates` column. */
export function parseReinforcementDates(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string' && d.length > 0) : [];
  } catch {
    return [];
  }
}

/** Adds `day` (YYYY-MM-DD) to the history, idempotent per day, keeping the newest MAX days. */
export function appendReinforcement(dates: string[], day: string, max = MAX_REINFORCEMENT_HISTORY): string[] {
  if (dates.includes(day)) return dates;
  return [...dates, day].sort().slice(-max);
}

function reinforcementSum(item: Rankable, today: Date): number {
  const createdDay = item.occurred_at.slice(0, 10);
  let sum = 0;
  for (const day of item.reinforcement_dates) {
    if (day !== createdDay) sum += Math.pow(ageDays(day, today), -ACT_R_DECAY);
  }
  return sum;
}

export function strength(item: Rankable, today: Date = new Date()): number {
  const created = Math.pow(ageDays(item.occurred_at, today), -ACT_R_DECAY);
  return Math.log(1 + created + ALPHA * reinforcementSum(item, today));
}

/**
 * Activation from re-confirmations alone (0 when never re-confirmed): a relevance boost for
 * search that, unlike strength(), does not also favour recent items.
 */
export function reinforcementStrength(item: Rankable, today: Date = new Date()): number {
  return Math.log(1 + ALPHA * reinforcementSum(item, today));
}

/**
 * Picks `count` items from a newest-first pool: the newest quarter is always kept, the remaining
 * slots go to the strongest of the rest, and the result is returned in pool order.
 */
export function rankByStrength<T extends Rankable>(pool: T[], count: number, today: Date = new Date()): T[] {
  if (pool.length <= count) return pool;
  const head = pool.slice(0, Math.min(count, Math.max(1, Math.ceil(count / 4))));
  const rest = pool
    .slice(head.length)
    .map((item, i) => ({ item, i, score: strength(item, today) }))
    .sort((a, b) => b.score - a.score || b.item.occurred_at.localeCompare(a.item.occurred_at) || a.i - b.i)
    .slice(0, count - head.length)
    .map((s) => s.item);
  const order = new Map(pool.map((item, i) => [item, i]));
  return [...head, ...rest].sort((a, b) => order.get(a)! - order.get(b)!);
}
