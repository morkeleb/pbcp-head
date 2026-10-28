// How a producer connects to this head, from one place: the public page (/connect), /llms.txt, and the owner's settings
// (GET /api/me/settings/snippets, the token just minted). The text a producer pastes comes from the protocol's own
// packages: `curlSnippet` and `producerConfig` (@pbcp/client), the §3 example card (@pbcp/core); each connector's setup
// lives in its README in the protocol repository, linked from here. Nothing connector-specific is written in this repo.

import { curlSnippet, producerConfig } from '@pbcp/client';
import { exampleCard, type ProducerCard } from '@pbcp/core';
import { DOCS_URL } from './front-door';

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
    `This is a head for the Personal Brief Card Protocol (PBCP): a person's agents and tools ("producers") send it cards — things they made, things they noticed, and decisions only that person can make — and the head folds them into one brief a day and records each decision. A producer talks to it over HTTP with a bearer token bound to one namespace root: it PUTs cards to ${facts.api}/cards/{id}, reads what happened to them from ${facts.api}/changes?after={seq}, and reads this head's description from GET ${origin}/. Tokens are minted by this head's owner on the settings page; there is no other way to get one.`,
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
    '## Links',
    '',
    ...links.head.map((l) => `- [${l.label}](${l.href})${l.note ? `: ${l.note}` : ''}`),
    ...links.connectors.map((l) => `- [Connector setup: ${l.label}](${l.href})`),
    '',
  ];
  return lines.join('\n');
}
