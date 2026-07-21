/**
 * Coordinator MCP server (ADR-0006, coordination batch B). Adapts the
 * application-layer read-only tools (`coordinatorTools.ts`) onto the MCP
 * wire so codex's coordinator run can call them (`codex exec` with this
 * server added via `codex mcp add`). This layer is a THIN adapter: it holds
 * no redaction logic of its own — every value it serializes already came
 * out of `CoordinatorReadTools`, whose views are the red-line-2 boundary
 * (no real path / worktree / threadKey / driver id). All tools are
 * read-only; there is deliberately no write/dispatch tool here (dispatch is
 * the coordinator's structured OUTPUT decision, not a tool it invokes).
 *
 * The factory takes the already-built tools so it stays free of IO and
 * unit-tests over an in-memory transport with fake tools; the stdio process
 * entrypoint that opens the real db/index and connects a
 * `StdioServerTransport` is wired separately (daemon/cli batch).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { CoordinatorReadTools } from '../application/coordinatorTools.js';

export const COORDINATOR_MCP_SERVER_NAME = 'amb-coordinator';
export const COORDINATOR_MCP_SERVER_VERSION = '0.1.0';

/** Serializes a tool's result as a single JSON text block (the shape the
 * coordinator agent parses). */
function jsonToolResult(payload: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

/**
 * Builds an `McpServer` exposing the coordinator's read-only tools. Caller
 * connects it to a transport (`StdioServerTransport` in production, an
 * in-memory transport in tests).
 */
export function buildCoordinatorMcpServer(tools: CoordinatorReadTools): McpServer {
  const server = new McpServer({
    name: COORDINATOR_MCP_SERVER_NAME,
    version: COORDINATOR_MCP_SERVER_VERSION,
  });

  server.registerTool(
    'list_projects',
    {
      description:
        'List the projects you may dispatch a task to, by name and aliases. Read-only; no filesystem paths are ever returned.',
    },
    () => jsonToolResult(tools.listProjects()),
  );

  server.registerTool(
    'list_sessions',
    {
      description:
        'List existing task sessions: an opaque ref, the bound project name, whether it has started, and timestamps. Read-only; no paths, thread ids, or driver ids are returned.',
    },
    () => jsonToolResult(tools.listSessions()),
  );

  return server;
}
