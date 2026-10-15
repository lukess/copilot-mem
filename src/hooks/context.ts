import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { summaryLines } from '../compress/summary.ts';
import { rankByStrength } from '../rank/reinforcement.ts';
import type { MemoryStore } from '../storage/memory-store.ts';

export const CONTEXT_ITEMS = 15;

const TOOLS_NOTE =
  'copilot-mem memory tools are available: search (compact index) -> timeline (context around an ID) -> ' +
  'get_observations (full details for chosen IDs). Use them when the user refers to earlier work or past context would help. ' +
  'remember saves a note the user explicitly asks to keep; bookmark saves your previous answer word for word when the user asks to bookmark it.';

function gitRoot(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return undefined;
  }
}

/**
 * The project at `cwd`. Inside a git repo: its root and the repository Copilot recorded for it.
 * Elsewhere (e.g. ~/dev): the directory itself and every repository worked on below it.
 */
export function projectForDir(
  store: MemoryStore,
  cwd: string,
): { root: string; git: boolean; repository?: string; repositories: string[] } {
  // Copilot records physical paths (macOS: /var -> /private/var), so match on the real path.
  let dir = cwd;
  try {
    dir = realpathSync(cwd);
  } catch {
    // keep cwd as given
  }
  const git = gitRoot(dir);
  const repositories = store.repositoriesForDir(git ?? dir);
  if (!git) return { root: dir, git: false, repositories };
  return { root: git, git: true, repository: repositories[0], repositories: repositories.slice(0, 1) };
}

/** Fits the hook's additionalContext alongside Copilot's own instructions. */
export const CONTEXT_BUDGET = 3_000;
/** Newest observations considered; reinforcement ranking picks CONTEXT_ITEMS of them. */
const CONTEXT_POOL = 75;
const MAX_NOTES = 5;
/** Pinned observations (dashboard) lead the context, newest first. */
export const MAX_PINNED = 10;
/** Of CONTEXT_ITEMS, at most this many come from projects linked with `copilot-mem link`. */
const LINKED_ITEMS = 5;
/** Repository names listed in the heading for a directory spanning several. */
const MAX_HEADING_REPOS = 5;

function heading(root: string, repository: string | undefined, repositories: string[], linked: string[]): string {
  if (repository || repositories.length === 0) {
    return `# copilot-mem: recent memory for ${repository ?? root}${linked.length ? ` (linked: ${linked.join(', ')})` : ''}`;
  }
  const shown = repositories.slice(0, MAX_HEADING_REPOS).join(', ');
  const more = repositories.length > MAX_HEADING_REPOS ? ` and ${repositories.length - MAX_HEADING_REPOS} more` : '';
  return `# copilot-mem: recent memory under ${root} (repositories: ${shown}${more})`;
}

/** Drops observations recorded as near-duplicates of a newer one already kept (pool is newest first). */
function withoutDuplicates<T extends { id: number }>(store: MemoryStore, pool: T[]): T[] {
  const links = store.duplicateLinks(pool.map((o) => o.id));
  const kept = new Set<number>();
  return pool.filter((o) => {
    const dup = links.some(([a, b]) => (a === o.id && kept.has(b)) || (b === o.id && kept.has(a)));
    if (!dup) kept.add(o.id);
    return !dup;
  });
}

/** Up to `count` non-note observations of `project`: newest and most reinforced, near-duplicates dropped. */
function pick(store: MemoryStore, project: string[], count: number, today: Date) {
  const pool = withoutDuplicates(
    store,
    store
      .searchObservations({ project, localOnly: true, limit: CONTEXT_POOL + MAX_NOTES + MAX_PINNED, offset: 0 })
      .filter((o) => o.type !== 'note' && o.type !== 'bookmark' && !o.pinned_at)
      .slice(0, CONTEXT_POOL),
  );
  const info = store.reinforcementInfo(pool.map((o) => o.id));
  return rankByStrength(pool.map((o) => ({ ...o, ...info.get(o.id)! })), count, today);
}

/**
 * Text for the sessionStart hook's additionalContext, within `budget` characters: what the user
 * pinned, the project's last session summary, the user's notes, then recent and re-confirmed observations.
 */
export function buildSessionContext(store: MemoryStore, cwd: string, budget = CONTEXT_BUDGET, today = new Date()): string {
  const { root, git, repository, repositories } = projectForDir(store, cwd);
  const project = [...repositories, root];
  // A directory spanning several repos already covers them; links apply to a single repo.
  const linked = git ? store.linkedProjects(project) : [];
  const [summary] = store.summaries({ project, limit: 1 });
  const pinned = store.searchObservations({ project, localOnly: true, pinned: true, limit: MAX_PINNED, offset: 0 });
  const notes = store.searchObservations({ project, type: 'note', limit: MAX_NOTES + MAX_PINNED, offset: 0 }).filter((o) => !o.pinned_at).slice(0, MAX_NOTES);
  const linkedPicked = linked.length ? pick(store, linked, LINKED_ITEMS, today) : [];
  const picked = pick(store, project, CONTEXT_ITEMS - linkedPicked.length, today);
  if (!summary && !pinned.length && !notes.length && !picked.length && !linkedPicked.length) return TOOLS_NOTE;

  const footer = ['', `${TOOLS_NOTE} Fetch details only for IDs that matter to the current task.`];
  const lines = [heading(root, repository, repositories, linked)];
  let size = lines[0].length + footer.join('\n').length + 1;
  const add = (section: string[]) => {
    // A heading only goes in with at least its first line.
    if (size + section[0].length + section[1].length + 2 > budget) return;
    for (const line of section) {
      if (size + line.length + 1 > budget) return;
      lines.push(line);
      size += line.length + 1;
    }
  };
  if (pinned.length) add(['## Pinned by the user', ...pinned.map((o) => `#${o.id} ${o.type}: ${o.title}`)]);
  if (summary) {
    add([`## Last session (${summary.occurred_at.slice(0, 10)})`, ...summaryLines(summary, ['request', 'completed', 'next_steps'])]);
  }
  if (notes.length) add(['## Notes saved by the user', ...notes.map((o) => `#${o.id} ${o.title}`)]);
  if (picked.length) {
    add(['## Observations (newest first)', ...picked.map((o) => `#${o.id} ${o.occurred_at.slice(0, 10)} ${o.type}: ${o.title}`)]);
  }
  if (linkedPicked.length) {
    add([
      '## From linked projects',
      ...linkedPicked.map((o) => `#${o.id} ${o.occurred_at.slice(0, 10)} [${o.repository ?? o.cwd}] ${o.type}: ${o.title}`),
    ]);
  }
  return [...lines, ...footer].join('\n');
}
