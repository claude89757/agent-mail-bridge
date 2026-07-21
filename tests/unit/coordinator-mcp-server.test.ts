import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import type { CoordinatorReadTools, SessionView } from '../../src/application/coordinatorTools.js';
import type { ProjectView } from '../../src/application/coordinatorViews.js';
import { buildCoordinatorMcpServer } from '../../src/transports/coordinatorMcpServer.js';

// Guards the coordination layer's batch-B MCP wiring (ADR-0006). Uses the
// SDK's in-memory transport pair to drive a REAL MCP handshake + tool call
// end to end, with fake tools, so it proves the adapter exposes exactly the
// two read-only tools and passes their (already-redacted) values through
// verbatim — no codex, no stdio, no filesystem.

const PROJECTS: readonly ProjectView[] = [{ name: 'blog', aliases: ['b', 'weblog'] }];
const SESSIONS: readonly SessionView[] = [
  {
    ref: '1',
    project: 'blog',
    hasStarted: false,
    startedAt: '2026-07-20T00:00:00.000Z',
    lastActivityAt: '2026-07-20T00:00:00.000Z',
  },
];

const fakeTools: CoordinatorReadTools = {
  listProjects: () => PROJECTS,
  listSessions: () => SESSIONS,
};

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new Error('expected a content array');
  }
  const first = content[0] as { type?: string; text?: string } | undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected a text content block');
  }
  return first.text;
}

describe('buildCoordinatorMcpServer (ADR-0006, coordination batch B/2)', () => {
  it('exposes exactly list_projects and list_sessions, passing redacted values through', async () => {
    const server = buildCoordinatorMcpServer(fakeTools);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(['list_projects', 'list_sessions']);

      const projects = await client.callTool({ name: 'list_projects' });
      expect(JSON.parse(textOf(projects))).toEqual(PROJECTS);

      const sessions = await client.callTool({ name: 'list_sessions' });
      expect(JSON.parse(textOf(sessions))).toEqual(SESSIONS);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
