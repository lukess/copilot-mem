export const SKILL_NAME = 'copilot-mem';

export const SKILL_MD = `---
name: ${SKILL_NAME}
description: Recall decisions, bug fixes, features, and discoveries from past GitHub Copilot CLI sessions with the copilot-mem memory tools. Use when the user refers to earlier work ("last time", "we decided", "that bug we fixed", "how did we...") or when knowing past context about this repository would help.
---

# copilot-mem memory

copilot-mem keeps a searchable memory of earlier Copilot CLI sessions. Each memory is an
*observation* (type: decision, bugfix, feature, refactor, change, or discovery) summarized from
past conversation turns, tagged with its repository and directory, a *note* (type: note) the
user asked to remember, or a *bookmark* (type: bookmark): an earlier answer saved word for word.

## Workflow (saves context: fetch details last)

1. \`copilot-mem-search\` with a few keywords. It returns a compact index:
   \`#id  date  type  title  [project]\`. Narrow it with \`project\` (\`owner/name\` or a
   directory), \`type\`, \`dateStart\`/\`dateEnd\`. Without a query it lists the newest observations.
2. \`copilot-mem-timeline\` with \`anchor: <id>\` shows what happened just before and after,
   in the same project.
3. \`copilot-mem-get_observations\` with \`ids: [...]\` returns the narrative, facts, concepts,
   and files for just the IDs that matter.

To resume earlier work, \`copilot-mem-summaries\` gives per-session recaps (request, what was
investigated, learned and completed, next steps), newest first.

When the user asks you to remember something ("remember that...", "note for next time"), call
\`copilot-mem-remember\` with a short \`title\` and self-contained \`text\`. It is saved for the
current repository (or pass \`project\`) and is never changed by compression.

When the user asks to bookmark, star or keep an answer you gave ("bookmark that"), call
\`copilot-mem-bookmark\` (optional \`title\`; \`back: 2\` for the answer before the last one). It
saves the question and your answer exactly, with the repository and path. Search returns
bookmarks from any project; quote a bookmark's answer as saved rather than paraphrasing it.

## Tips

- Search with specific nouns: file names, function names, error text, library names.
- The session-start context recaps the last session and lists notes and recent or frequently
  re-confirmed observation IDs for this project (and projects the user linked to it); fetch
  them directly. Searching with \`project\` also covers linked projects.
- Memory can be stale. Verify against the current code before acting on it, and say when an
  answer comes from memory.
- Memory only covers sessions that have been compressed. \`copilot-mem status\` shows coverage.
`;
