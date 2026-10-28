# @pbcp-head/owner-mcp

An MCP server for a head's **owner**: an assistant reads the owner's brief and records what the owner decides. It is one more owner client, like the web brief, built only on the owner's API (`/api/me`, typed from `packages/api-types/openapi.json`); nothing in it is protocol, and it never acts as a producer.

## Tools

| Tool | What it does |
| --- | --- |
| `brief` | Today's brief (or an earlier `day`): the daily paragraph, open decisions with their choices (the default marked), updates and signals folded by thread, the snoozed count |
| `list_cards` | Compact rows by day range, label, producer, kind, state |
| `get_card` | One card in full: the body as markdown (never HTML), its thread, its decision log |
| `decide` | Records a decision: an action id or `dismissed`, an optional comment, optional edited text |
| `acknowledge`, `snooze`, `unsnooze` | Acknowledge an update or signal; set a card aside until a UTC time; bring it back |
| `create_order` | Gives an order to a producer, or to `*` |

Results are compact JSON. Refusals come back as tool errors in the head's own words (a decision that is no longer open says what was decided).

## Two ways to run it

- **Remote:** the head serves these tools at `/api/mcp`, with OAuth 2.1 (PKCE S256, dynamic client registration). Add `https://<head>/api/mcp` as a custom connector in the Claude app; see `docs/deploy.md`.
- **stdio:** `pbcp-owner-mcp` (`dist/stdio.js`, built with `pnpm build`) for Claude Desktop or any local MCP client:

```sh
node dist/stdio.js login https://<head>   # once: OAuth through a loopback redirect; prints PBCP_HEAD_URL and PBCP_SESSION
```

```json
{
  "mcpServers": {
    "brief": {
      "command": "node",
      "args": ["/absolute/path/to/packages/owner-mcp/dist/stdio.js"],
      "env": { "PBCP_HEAD_URL": "https://<head>", "PBCP_SESSION": "<printed by login>" }
    }
  }
}
```

`PBCP_SESSION` is `<client id>:<refresh token>`; a producer token is refused. Refresh tokens rotate on every use; the newest is kept in `$XDG_CONFIG_HOME/pbcp-owner-mcp/<host>.json` (mode 0600) and used in preference to the environment's.

## Development

- `pnpm api-types` regenerates `src/api.d.ts` from the head's OpenAPI document.
- `src/index.ts` is what the head imports (`createOwnerServer`); `src/stdio.ts` is the binary.
- The tests are the head's: `test/http/owner-mcp.test.ts`.
