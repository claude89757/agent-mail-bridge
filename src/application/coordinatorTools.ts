/**
 * Coordinator read-only tools (ADR-0006, coordination batch B). The values
 * codex's coordinator agent may read via MCP. This batch wires
 * `list_projects` + `list_sessions`; `get_status` (which joins intent /
 * command progress) follows in a later batch.
 *
 * Every return value is a red-line-2 redaction boundary: no real projectPath,
 * worktreePath, threadKey (a Message-ID that can carry a mail domain), or
 * codex driver session id ever crosses to the coordinator. A session's
 * project is shown by NAME (looked up from its stored path via the trusted
 * index) or `null` when that project has left the index — never the orphan
 * path.
 *
 * Pure projection over injected collaborators (the project index + the
 * session store), so it unit-tests with a real in-memory store and a
 * hand-built index, with no MCP server and no codex in the loop — the MCP
 * server layer (next batch) only adapts these onto the wire, holding no
 * redaction logic of its own.
 */
import type { ProjectIndex } from './projectIndex.js';
import { toProjectViews, type ProjectView } from './coordinatorViews.js';
import type { SessionStore } from '../store/sessionStore.js';

/**
 * What the coordinator sees about one session — deliberately NONE of the
 * stored path/worktree/threadKey/driver-id fields. `ref` is the session's
 * opaque id (the handle a later `get_status` tool takes); `project` is the
 * bound project's NAME, or `null` if that project is no longer in the index
 * (the orphan path is never surfaced).
 */
export interface SessionView {
  readonly ref: string;
  readonly project: string | null;
  readonly hasStarted: boolean;
  readonly startedAt: string;
  readonly lastActivityAt: string;
}

export interface CoordinatorReadToolsDeps {
  readonly index: ProjectIndex;
  readonly sessionStore: SessionStore;
}

export interface CoordinatorReadTools {
  listProjects(): readonly ProjectView[];
  listSessions(): readonly SessionView[];
}

/**
 * Builds the read-only tool set over the injected index + session store.
 * The `nameByPath` map is the reverse of the alias->path lookup, built once
 * from the trusted index and used ONLY to redact a session's stored
 * projectPath down to a name (or `null` when the project has left the
 * index) — it is never a way to turn coordinator-supplied text into a path.
 */
export function buildCoordinatorReadTools(deps: CoordinatorReadToolsDeps): CoordinatorReadTools {
  const nameByPath = new Map<string, string>();
  for (const entry of deps.index.entries) {
    nameByPath.set(entry.path, entry.name);
  }

  return {
    listProjects() {
      return toProjectViews(deps.index.entries);
    },
    listSessions() {
      return deps.sessionStore.listAll().map((session) => ({
        ref: String(session.id),
        project: nameByPath.get(session.projectPath) ?? null,
        hasStarted: session.driverSessionId !== null,
        startedAt: session.createdAt,
        lastActivityAt: session.updatedAt,
      }));
    },
  };
}
