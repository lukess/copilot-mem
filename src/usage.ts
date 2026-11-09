/** Copilot CLI usage per local day, session, model and initiator, read from session-store.db. */
export interface UsageRow {
  day: string;
  session_id: string;
  model: string;
  initiator: string | null;
  calls: number;
  /** Calls Copilot recorded without a price (total_nano_aiu NULL); counted in calls, not credits. */
  unpriced: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  credits: number;
}

export interface UsageSession {
  id: string;
  repository: string | null;
  cwd: string | null;
  summary: string | null;
}

export interface UsageData {
  rows: UsageRow[];
  sessions: UsageSession[];
}

interface Totals {
  credits: number;
  calls: number;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface UsageGroup {
  name: string;
  credits: number;
  calls: number;
}

export interface UsageReport {
  available: true;
  from: string;
  to: string;
  days: number;
  totals: Totals;
  daily: { day: string; credits: number; models: Record<string, number> }[];
  models: UsageGroup[];
  initiators: UsageGroup[];
  repositories: UsageGroup[];
  topSessions: (UsageGroup & { id: string; repository: string | null; cwd: string | null; models: string[]; lastDay: string })[];
  month: {
    month: string;
    credits: number;
    daysElapsed: number;
    daysInMonth: number;
    projected: number;
    budget: number | null;
    /** over: spent more than the budget; warn: projected to reach 80% of it. */
    status: 'ok' | 'warn' | 'over' | null;
  };
}

export const TOP_SESSIONS = 10;
const WARN_SHARE = 0.8;

function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local midnight `days - 1` days before `now`, or the first of the month if earlier (the budget needs the whole month). */
export function usageSince(days: number, now = new Date()): string {
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return (windowStart < monthStart ? windowStart : monthStart).toISOString();
}

function addGroup(groups: Map<string, UsageGroup>, name: string, row: UsageRow): void {
  let g = groups.get(name);
  if (!g) groups.set(name, (g = { name, credits: 0, calls: 0 }));
  g.credits += row.credits;
  g.calls += row.calls;
}

const byCredits = (a: UsageGroup, b: UsageGroup) => b.credits - a.credits || b.calls - a.calls || a.name.localeCompare(b.name);

/** Totals, daily credits by model, breakdowns and month-to-date budget status for the last `days` local days. */
export function summarizeUsage(data: UsageData, options: { days: number; budget: number | null; now?: Date }): UsageReport {
  const now = options.now ?? new Date();
  const to = localYmd(now);
  const from = localYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (options.days - 1)));
  const month = to.slice(0, 7);
  const sessions = new Map(data.sessions.map((s) => [s.id, s]));

  const totals: Totals = { credits: 0, calls: 0, unpricedCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const daily = new Map<string, { day: string; credits: number; models: Record<string, number> }>();
  for (let d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (options.days - 1)); localYmd(d) <= to; d.setDate(d.getDate() + 1)) {
    daily.set(localYmd(d), { day: localYmd(d), credits: 0, models: {} });
  }
  const models = new Map<string, UsageGroup>();
  const initiators = new Map<string, UsageGroup>();
  const repositories = new Map<string, UsageGroup>();
  const perSession = new Map<string, UsageGroup & { models: Set<string>; lastDay: string }>();
  let monthCredits = 0;

  for (const row of data.rows) {
    if (!row.day || row.day > to) continue;
    if (row.day.slice(0, 7) === month) monthCredits += row.credits;
    if (row.day < from) continue;
    totals.credits += row.credits;
    totals.calls += row.calls;
    totals.unpricedCalls += row.unpriced;
    totals.inputTokens += row.input_tokens;
    totals.outputTokens += row.output_tokens;
    totals.cacheReadTokens += row.cache_read_tokens;
    const day = daily.get(row.day)!;
    day.credits += row.credits;
    day.models[row.model] = (day.models[row.model] ?? 0) + row.credits;
    addGroup(models, row.model, row);
    addGroup(initiators, row.initiator || '(unknown)', row);
    const session = sessions.get(row.session_id);
    addGroup(repositories, session?.repository || session?.cwd || '(unknown)', row);
    let s = perSession.get(row.session_id);
    if (!s) perSession.set(row.session_id, (s = { name: session?.summary || row.session_id, credits: 0, calls: 0, models: new Set(), lastDay: row.day }));
    s.credits += row.credits;
    s.calls += row.calls;
    s.models.add(row.model);
    if (row.day > s.lastDay) s.lastDay = row.day;
  }

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysElapsed = now.getDate();
  const projected = (monthCredits / daysElapsed) * daysInMonth;
  const budget = options.budget;
  const status = budget === null ? null : monthCredits > budget ? 'over' : projected >= budget * WARN_SHARE ? 'warn' : 'ok';

  return {
    available: true,
    from,
    to,
    days: options.days,
    totals,
    daily: [...daily.values()],
    models: [...models.values()].sort(byCredits),
    initiators: [...initiators.values()].sort(byCredits),
    repositories: [...repositories.values()].sort(byCredits),
    topSessions: [...perSession.entries()]
      .map(([id, s]) => ({
        id,
        name: s.name,
        repository: sessions.get(id)?.repository ?? null,
        cwd: sessions.get(id)?.cwd ?? null,
        credits: s.credits,
        calls: s.calls,
        models: [...s.models].sort(),
        lastDay: s.lastDay,
      }))
      .sort(byCredits)
      .slice(0, TOP_SESSIONS),
    month: { month, credits: monthCredits, daysElapsed, daysInMonth, projected, budget, status },
  };
}
