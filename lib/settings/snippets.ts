// Ready-to-paste ways to connect a producer to a head: curl, an n8n HTTP Request node, and Hermes over MCP
// (connectors/hermes in the protocol repo). One file, plain strings and no dependencies, so the settings page, the
// phone app (through GET /api/me/settings/snippets) and the documentation site all show the same text.

export interface SnippetInput {
  /** The head URL a producer is given: the origin plus /api (GET {url}/ describes the head, PUT {url}/cards/{id} submits). */
  url: string;
  /** The owner's person id: every card's `to_person` (§10). */
  owner: string;
  /** The producer's root: every id it submits starts with it (§5, §12). */
  root: string;
  /** The producer token, or TOKEN_PLACEHOLDER once it has been shown. */
  token: string;
}

export const TOKEN_PLACEHOLDER = '<producer token>';

export interface Snippets {
  curl: string;
  n8n: string;
  hermes: string;
}

export const SNIPPET_TABS: Array<{ key: keyof Snippets; label: string }> = [
  { key: 'curl', label: 'curl' },
  { key: 'n8n', label: 'n8n' },
  { key: 'hermes', label: 'Hermes' },
];

export function snippets({ url, owner, root, token }: SnippetInput): Snippets {
  const base = url.replace(/\/+$/, '');
  const id = `${root}:hello:first`;

  // One complete minimal card (§4.1): an artifact needs no actions.
  const curl = [
    `curl -X PUT "${base}/cards/${id}" \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  --data @- <<EOF`,
    `{`,
    `  "protocol": "pbcp/1",`,
    `  "id": "${id}",`,
    `  "kind": "artifact",`,
    `  "to_person": "${owner}",`,
    `  "producer": "${root}",`,
    `  "title": "Hello from ${root}",`,
    `  "body": "The first card from ${root}.",`,
    `  "emitted_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
    `}`,
    `EOF`,
  ].join('\n');

  // An HTTP Request node, pasted onto the n8n canvas. The id carries today's date, so the workflow's daily run is one
  // card a day, and a re-run the same day replaces it rather than adding another (§5).
  const day = "{{ $now.toFormat('yyyy-MM-dd') }}";
  const n8nNode = {
    nodes: [
      {
        name: 'Submit card',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [0, 0],
        parameters: {
          method: 'PUT',
          url: `=${base}/cards/${root}:daily:${day}`,
          sendHeaders: true,
          headerParameters: { parameters: [{ name: 'Authorization', value: `Bearer ${token}` }] },
          sendBody: true,
          specifyBody: 'json',
          jsonBody: `=${JSON.stringify(
            {
              protocol: 'pbcp/1',
              id: `${root}:daily:${day}`,
              kind: 'artifact',
              to_person: owner,
              producer: root,
              title: `${root} for ${day}`,
              body: 'What the workflow found today.',
              emitted_at: '{{ $now.toUTC().toISO({ suppressMilliseconds: true }) }}',
            },
            null,
            2,
          )}`,
        },
      },
    ],
    connections: {},
  };
  const n8n = JSON.stringify(n8nNode, null, 2);

  // Hermes runs the protocol's MCP server (@pbcp/mcp) over stdio, with the head and the token in its environment.
  const hermes = [
    ...(root === 'hermes' ? [] : [`# Hermes submits under the root hermes; this token is for ${root}. Mint one for hermes to use it as is.`]),
    '# The MCP server: npx -y @pbcp/mcp (stdio), configured by two variables',
    `export PBCP_HEAD_URL=${base}`,
    `export PBCP_TOKEN=${token}`,
    '',
    '# The plugin (connectors/hermes in the protocol repository)',
    'hermes plugins install ./connectors/hermes',
    'hermes plugins enable pbcp',
    '',
    '# Its mcp.json:',
    JSON.stringify(
      {
        mcpServers: {
          pbcp: { type: 'stdio', command: 'npx', args: ['-y', '@pbcp/mcp'], env: { PBCP_HEAD_URL: '${PBCP_HEAD_URL}', PBCP_TOKEN: '${PBCP_TOKEN}' } },
        },
      },
      null,
      2,
    ),
  ].join('\n');

  return { curl, n8n, hermes };
}
