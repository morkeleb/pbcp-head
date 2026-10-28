// How a producer connects to this head, from one place: the public page (/connect), /llms.txt, and the owner's settings
// (GET /api/me/settings/snippets, the token just minted). The text a producer pastes comes from the protocol's own
// packages: `curlSnippet` and `producerConfig` (@pbcp/client), the §3 example card (@pbcp/core); each connector's setup
// lives in its README in the protocol repository, linked from here. Nothing connector-specific is written in this repo.

import { curlSnippet, producerConfig, shellQuote } from '@pbcp/client';
import { exampleCard, type ProducerCard } from '@pbcp/core';
import { TOOL_NAMES } from '@pbcp-head/owner-mcp';
import { DOCS_URL } from './front-door';
import { mcpUrl } from './oauth';

/** The only token there is on a public page: a placeholder. */
export const TOKEN = '<token>';
/** On a deployment that serves several heads, the owner id is the owner's to give (from their settings page). */
export const OWNER = '<owner>';

/** The protocol's connectors with a Setup section in their README, in the order a newcomer meets them. */
export const CONNECTORS = ['hermes', 'n8n', 'imap', 'caldav', 'todoist', 'goalpath'] as const;
export const PROTOCOL_REPO = 'https://github.com/morkeleb/pbcp';
export const connectorSetup = (name: string) => `${PROTOCOL_REPO}/blob/main/connectors/${name}/README.md#setup`;

export interface ConnectFacts {
  /** The base URL of the producer operations, as the description gives it (§7.5 `api`). */
  api: string;
  /** The owner's person id (§10), or null on a deployment with several heads. */
  owner: string | null;
  protocol: string;
  extensions: string[];
}

export interface Link {
  label: string;
  href: string;
  note?: string;
}

/** Where to read more: this head's API contract, the protocol documentation and its RFC, and each connector's setup. */
export function connectLinks(origin: string): { head: Link[]; connectors: Link[] } {
  const docs = DOCS_URL.replace(/\/+$/, '');
  return {
    head: [
      { label: 'This head’s API', href: `${origin}/api/openapi.json`, note: 'OpenAPI, the owner’s /api/me routes' },
      { label: 'The protocol documentation', href: docs },
      { label: 'The specification', href: `${docs}/rfc.md`, note: 'the RFC as markdown' },
    ],
    connectors: CONNECTORS.map((name) => ({ label: name, href: connectorSetup(name) })),
  };
}

/**
 * Pairing (lib/settings/pairing.ts), in the words an agent needs: how a producer gets a token of its own from a code the
 * owner gives it, instead of the owner copying a token across.
 */
export function pairingSteps(api: string): string[] {
  return [
    'Ask the owner for a pairing code. They make one in Settings → Producers; it is 6 characters, valid 10 minutes, and works once.',
    `POST it with the root you choose (letters, digits and -; every card id you send starts with it) to ${api}/pair: {"code": "<code>", "root": "<root>", "name": "<what you are>"}.`,
    'Keep the token in the answer: it is shown this once. The answer also gives `api`, `owner` and `root`.',
    'Use `api`, `owner` and the token as the three values (PBCP_HEAD_URL, PBCP_TO_PERSON, PBCP_TOKEN).',
  ];
}

/** The pairing request as a curl, with <code>, <root> and <name> to fill in. */
export function pairCurl(api: string): string {
  return [
    `curl -s -X POST ${shellQuote(`${api.replace(/\/+$/, '')}/pair`)} \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  --data-binary @- <<'PAIR'`,
    JSON.stringify({ code: '<code>', root: '<root>', name: '<name>' }, null, 2),
    'PAIR',
  ].join('\n');
}

/**
 * Using the head from an assistant (an MCP client) on the owner's behalf: not as a producer, but as the owner, through
 * the owner's MCP server at /api/mcp (lib/oauth.ts, packages/owner-mcp).
 */
export function assistantAccess(origin: string) {
  return {
    url: mcpUrl(origin),
    tools: [...TOOL_NAMES],
    lines: [
      `MCP server (streamable HTTP): ${mcpUrl(origin)}`,
      `Authorisation: OAuth 2.1 with PKCE (S256) and dynamic client registration; the metadata is at ${origin}/.well-known/oauth-authorization-server and ${origin}/.well-known/oauth-protected-resource. The owner signs in with a passkey and allows the app; they can sign it out in Settings → Devices.`,
      `Tools: ${TOOL_NAMES.join(', ')}.`,
    ],
  };
}

/** The card the curl sends: the §3 example (its root is `hermes`), or, for a token of another root, a one-line artifact under it. */
export function curlCard(owner: string, root?: string): ProducerCard | undefined {
  if (root === undefined || root === exampleCard.producer) return undefined; // curlSnippet sends the §3 example
  return {
    protocol: 'pbcp/1',
    id: `${root}:hello:first`,
    kind: 'artifact',
    to_person: owner,
    producer: root,
    title: `Hello from ${root}`,
    body: `The first card from ${root}.`,
    emitted_at: exampleCard.emitted_at,
  };
}

/** What a producer pastes: the three values and a curl that PUTs a card, for `token` (a placeholder on public pages). */
export function connectSnippets(facts: ConnectFacts, token: string, root?: string) {
  const owner = facts.owner ?? OWNER;
  const card = curlCard(owner, root);
  return {
    config: producerConfig({ api: facts.api, owner, token }),
    curl: curlSnippet({ api: facts.api, owner, token, ...(card ? { card } : {}) }),
    /** The root the curl's card is under; its token must be bound to it (§12). */
    curlRoot: card?.producer ?? exampleCard.producer,
  };
}

/** /llms.txt: what this head is, how a producer talks to it, the facts, and the links; the same as /connect. */
export function llmsTxt(facts: ConnectFacts, origin: string): string {
  const { config, curl, curlRoot } = connectSnippets(facts, TOKEN);
  const links = connectLinks(origin);
  const lines = [
    '# This head',
    '',
    `This is a head for the Personal Brief Card Protocol (PBCP): a person's agents and tools ("producers") send it cards — things they made, things they noticed, and decisions only that person can make — and the head folds them into one brief a day and records each decision. A producer talks to it over HTTP with a bearer token bound to one namespace root: it PUTs cards to ${facts.api}/cards/{id}, reads what happened to them from ${facts.api}/changes?after={seq}, and reads this head's description from GET ${origin}/. Tokens come from this head's owner: either they mint one on the settings page and give it to you, or they give you a pairing code and you mint your own.`,
    '',
    '## Pairing: getting a token with a code',
    '',
    ...pairingSteps(facts.api).map((step, i) => `${i + 1}. ${step}`),
    '',
    '```sh',
    pairCurl(facts.api),
    '```',
    '',
    'A wrong, expired or used code is answered 400 invalid_code, and every outstanding code is then void: ask the owner for a new one. A root that already has a token is 409 root_taken; choose another and try again with the same code.',
    '',
    '## Facts',
    '',
    `- API base: ${facts.api}`,
    `- Owner id (to_person): ${facts.owner ?? `${OWNER} (this deployment serves several heads; the owner id comes from the owner's settings page)`}`,
    `- Protocol: ${facts.protocol}`,
    `- Extensions: ${facts.extensions.length ? facts.extensions.join(', ') : 'none'}`,
    '',
    '## The three values',
    '',
    ...Object.entries(config).map(([k, v]) => `- ${k}=${v}`),
    '',
    `## A first card (the token must be bound to the root ${curlRoot})`,
    '',
    '```sh',
    curl,
    '```',
    '',
    '## Use this head from an assistant',
    '',
    'An assistant acting for the owner (reading the brief to them, recording what they decide) connects to the owner’s MCP server, not as a producer:',
    '',
    ...assistantAccess(origin).lines.map((l) => `- ${l}`),
    '',
    '## Links',
    '',
    ...links.head.map((l) => `- [${l.label}](${l.href})${l.note ? `: ${l.note}` : ''}`),
    ...links.connectors.map((l) => `- [Connector setup: ${l.label}](${l.href})`),
    '',
  ];
  return lines.join('\n');
}
