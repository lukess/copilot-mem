import { projectForDir } from './hooks/context.ts';
import type { MemoryStore } from './storage/memory-store.ts';

export const MAX_TITLE = 120;
export const MAX_TEXT = 4000;
export const MAX_FACTS = 20;

export interface NoteInput {
  title: string;
  text: string;
  facts?: string[];
  files?: string[];
  /** Repository ("owner/name") or absolute directory; defaults to the project at `cwd`. */
  project?: string;
}

/** Validates and saves a user-authored note; returns its observation ID and project. */
export function rememberNote(store: MemoryStore, input: NoteInput, cwd: string, now = new Date().toISOString()): { id: number; project: string } {
  const title = input.title.trim();
  const text = input.text.trim();
  if (!title) throw new Error('title is required');
  if (title.length > MAX_TITLE) throw new Error(`title must be at most ${MAX_TITLE} characters`);
  if (!text) throw new Error('text is required');
  if (text.length > MAX_TEXT) throw new Error(`text must be at most ${MAX_TEXT} characters`);
  const facts = (input.facts ?? []).map((f) => f.trim()).filter(Boolean);
  if (facts.length > MAX_FACTS) throw new Error(`at most ${MAX_FACTS} facts`);
  const files = (input.files ?? []).map((f) => f.trim()).filter(Boolean);
  let project = input.project?.trim().replace(/(.)\/+$/, '$1');
  if (!project) {
    const here = projectForDir(store, cwd);
    project = here.repository ?? here.root;
  }
  if (!project.startsWith('/') && !/^[\w.-]+\/[\w.-]+$/.test(project)) {
    throw new Error('project must be a repository ("owner/name") or an absolute directory');
  }
  return { id: store.remember(project, { title, narrative: text, facts, files }, now), project };
}
