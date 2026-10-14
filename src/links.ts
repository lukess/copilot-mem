import type { MemoryStore } from './storage/memory-store.ts';

function normalize(project: string): string {
  const p = project.trim().replace(/(.)\/+$/, '$1');
  if (!p.startsWith('/') && !/^[\w.-]+\/[\w.-]+$/.test(p)) {
    throw new Error(`"${project}": a project is a repository ("owner/name") or an absolute directory`);
  }
  return p;
}

function projects(args: string[]): string[] {
  const list = [...new Set(args.map(normalize))];
  if (list.length < 2) throw new Error('give at least two different projects');
  return list;
}

/** `copilot-mem link A B [C...]`: every pair becomes related, both ways. Returns the message to print. */
export function linkProjects(store: MemoryStore, args: string[], now: string): string {
  const list = projects(args);
  const known = new Set(store.projects().map((p) => p.project));
  const added = store.linkProjects(list, now);
  const unknown = list.filter((p) => !known.has(p));
  return [
    `Linked ${list.join(', ')} (${added} new pair(s)). Session-start context in each now includes recent work from the others, and searching one covers them all.`,
    ...unknown.map((p) => `Note: no memory recorded for ${p} yet (check the name with \`copilot-mem links\` or the viewer's project list).`),
  ].join('\n');
}

/** `copilot-mem unlink A B [C...]`: removes the links between every pair. */
export function unlinkProjects(store: MemoryStore, args: string[]): string {
  const list = projects(args);
  return `Removed ${store.unlinkProjects(list)} link(s) between ${list.join(', ')}.`;
}

/** `copilot-mem links`: each project with what it is linked to. */
export function listLinks(store: MemoryStore): string {
  const byProject = new Map<string, string[]>();
  for (const [a, b] of store.projectLinks()) {
    byProject.set(a, [...(byProject.get(a) ?? []), b]);
    byProject.set(b, [...(byProject.get(b) ?? []), a]);
  }
  if (byProject.size === 0) return 'No linked projects. Link related ones with `copilot-mem link <project> <project>...`.';
  return [...byProject.keys()].sort().map((p) => `${p} -> ${byProject.get(p)!.sort().join(', ')}`).join('\n');
}
