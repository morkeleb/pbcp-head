// The owner's MCP tools (src/tools.ts) over the owner's API (src/client.ts). The head serves them at /api/mcp; the
// stdio binary (src/stdio.ts) serves them to a desktop client.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createOwnerClient, type OwnerClientOptions } from './client';
import { registerOwnerTools } from './tools';

export { createOwnerClient, HeadError, type OwnerClient, type OwnerClientOptions } from './client';
export { choices, plainText, registerOwnerTools, TOOL_NAMES } from './tools';

export const SERVER_INFO = { name: 'pbcp-owner', version: '0.1.0' } as const;

const INSTRUCTIONS =
  'These tools read the owner’s brief from their PBCP head and record what the owner decides. Read the brief before acting. ' +
  'Decide, give orders or snooze only when the owner has said so; a decision is final once recorded.';

/** An MCP server with the owner's tools, talking to the head as `opts` says. */
export function createOwnerServer(opts: OwnerClientOptions): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerOwnerTools(server, createOwnerClient(opts));
  return server;
}
