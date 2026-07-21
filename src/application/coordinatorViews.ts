/**
 * Coordinator-facing views (ADR-0006, coordination batch A). The forward
 * half of the alias<->path redaction: turns internal `ProjectEntry`s (which
 * carry the one trusted real `.path`) into `ProjectView`s that carry NO
 * path, for anything the coordinator agent may see — the read-only MCP
 * tools' return values (batch B) and any reply text.
 *
 * This is AGENTS.md red line 2 made structural: a real local path can never
 * reach the coordinator or the mail body, because the only type that
 * crosses that boundary (`ProjectView`) has no field to carry one. The
 * reverse direction (an alias the coordinator names -> a real path) is NOT
 * here and never widens: it stays `projectIndex.lookup`, whose result is
 * the sole trusted path source (`projectIndex.ts`'s core invariant).
 *
 * Lives in `application/` rather than `domain/` because it depends on
 * `application/projectIndex.ts`'s `ProjectEntry`; keeping the dependency
 * pointing application -> (its own module) preserves the domain layer's
 * IO-free, application-free purity (spec §3.1). Pure function, no IO.
 */
import type { ProjectEntry } from './projectIndex.js';

/** What the coordinator agent is allowed to see about a project: its name
 * and aliases, never its path. */
export interface ProjectView {
  readonly name: string;
  readonly aliases: readonly string[];
}

/** Projects one `ProjectEntry` to its path-free `ProjectView`. */
export function toProjectView(entry: ProjectEntry): ProjectView {
  return { name: entry.name, aliases: entry.aliases };
}

/** Projects a list of entries, preserving order. */
export function toProjectViews(entries: readonly ProjectEntry[]): readonly ProjectView[] {
  return entries.map(toProjectView);
}
