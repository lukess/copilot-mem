import type { MemoryStore, ObservationDetail, ObservationType, SessionSummary } from '../storage/memory-store.ts';

/** Most observations one export includes (newest, or best matches for a query). */
export const MAX_EXPORT_OBSERVATIONS = 2_000;
const MAX_EXPORT_SUMMARIES = 500;
const TYPE_ORDER: ObservationType[] = ['feature', 'bugfix', 'decision', 'refactor', 'change', 'discovery', 'note', 'bookmark'];
const TYPE_HEADINGS: Record<ObservationType, string> = {
  feature: 'Features',
  bugfix: 'Bug fixes',
  decision: 'Decisions',
  refactor: 'Refactors',
  change: 'Changes',
  discovery: 'Discoveries',
  note: 'Notes',
  bookmark: 'Bookmarked answers',
};

export interface ExportFilter {
  project?: string;
  query?: string;
  type?: ObservationType;
  pinned?: boolean;
  dateStart?: string;
  dateEnd?: string;
  /** Labels for the range as the user picked it (local dates), shown in the heading. */
  from?: string;
  to?: string;
}

const day = (iso: string | null) => (iso ?? '').slice(0, 10);
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** A Markdown digest of the observations and session summaries matching the dashboard's filters. */
export function exportMarkdown(store: MemoryStore, filter: ExportFilter, now = new Date()): string {
  const found = store.searchObservations({ ...filter, limit: MAX_EXPORT_OBSERVATIONS, offset: 0 });
  const observations = store.getObservations(found.map((o) => o.id));
  // Summaries describe whole sessions, so they only fit an export that isn't narrowed by query, type or pins.
  const summaries =
    filter.query || filter.type || filter.pinned ? [] : store.summaries({ ...filter, project: filter.project, limit: MAX_EXPORT_SUMMARIES });

  const byProject = new Map<string, { observations: ObservationDetail[]; summaries: SessionSummary[] }>();
  const group = (project: string) => {
    let g = byProject.get(project);
    if (!g) byProject.set(project, (g = { observations: [], summaries: [] }));
    return g;
  };
  for (const o of observations) group(o.repository ?? o.cwd ?? '(unknown)').observations.push(o);
  for (const s of summaries) group(s.repository ?? s.cwd ?? '(unknown)').summaries.push(s);
  const projects = [...byProject.entries()].sort(
    (a, b) => b[1].observations.length + b[1].summaries.length - (a[1].observations.length + a[1].summaries.length) || a[0].localeCompare(b[0]),
  );

  const scope = [
    filter.project ? `project \`${filter.project}\`` : 'all projects',
    filter.from || filter.to ? `${filter.from ?? 'start'} to ${filter.to ?? 'now'}` : 'all time',
    filter.query ? `matching "${filter.query}"` : '',
    filter.type ? `type ${filter.type}` : '',
    filter.pinned ? 'pinned only' : '',
  ].filter(Boolean);
  const out = [
    '# copilot-mem export',
    '',
    `${scope.join(', ')}. Generated ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    '',
    `${observations.length} observation(s)${summaries.length ? ` and ${summaries.length} session summar${summaries.length === 1 ? 'y' : 'ies'}` : ''} across ${projects.length} project(s).` +
      (found.length === MAX_EXPORT_OBSERVATIONS ? ` Capped at ${MAX_EXPORT_OBSERVATIONS} observations; narrow the filters for the rest.` : ''),
  ];
  if (!projects.length) out.push('', 'Nothing matches these filters.');

  for (const [project, g] of projects) {
    const dates = [...g.observations.map((o) => day(o.occurred_at)), ...g.summaries.map((s) => day(s.occurred_at))].filter(Boolean).sort();
    out.push('', `## ${project}`, '');
    out.push(`${g.observations.length} observation(s)${dates.length ? `, ${dates[0]} to ${dates[dates.length - 1]}` : ''}.`);
    if (g.summaries.length) {
      out.push('', '### Sessions', '');
      for (const s of [...g.summaries].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))) {
        out.push(`- **${day(s.occurred_at)}** ${oneLine(s.request)}${s.completed ? ` - ${oneLine(s.completed)}` : ''}`);
      }
    }
    for (const type of TYPE_ORDER) {
      const items = g.observations.filter((o) => o.type === type).sort((a, b) => day(a.occurred_at).localeCompare(day(b.occurred_at)) || a.id - b.id);
      if (!items.length) continue;
      out.push('', `### ${TYPE_HEADINGS[type]}`, '');
      for (const o of items) {
        if (o.type !== 'bookmark') {
          out.push(`- ${day(o.occurred_at)} **${oneLine(o.title)}**${o.subtitle ? ` - ${oneLine(o.subtitle)}` : ''} (#${o.id})`);
          continue;
        }
        // Bookmarks are kept for their exact text, so the export carries the full question and answer.
        const indent = (text: string) => text.split('\n').map((l) => (l ? `  ${l}` : '')).join('\n');
        out.push(`- ${day(o.occurred_at)} **${oneLine(o.title)}** (#${o.id})`, '', indent(`> ${oneLine(o.question ?? o.subtitle)}`), '', indent(o.narrative), '');
      }
    }
  }
  return `${out.join('\n')}\n`;
}
