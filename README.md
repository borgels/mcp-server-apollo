# mcp-server-apollo

MCP (Model Context Protocol) server for the [Apollo.io](https://www.apollo.io) B2B
discovery and enrichment API: company search, people search, contact
enrichment (emails/phones), organization firmographics, and API usage stats.

The server wraps Apollo's REST API with one account-level API key kept
server-side. It is read-only by design: no sequences, no emailer, no CRM
writes, no account management.

## Tools

| Tool | Risk | Apollo endpoint |
| --- | --- | --- |
| `apollo_search_capabilities` | read | — (local discovery) |
| `apollo_companies_search` | read + 1 credit/page | `POST /mixed_companies/search` |
| `apollo_people_search` | read (free, master key) | `POST /mixed_people/api_search` |
| `apollo_person_enrich` | read + credits | `POST /people/match` |
| `apollo_people_bulk_enrich` | read + credits | `POST /people/bulk_match` (chunked ×10) |
| `apollo_org_enrich` | read + 1 credit | `GET /organizations/enrich` |
| `apollo_webhook_result` | read (free) | `GET /webhook_result/{request_id}` |
| `apollo_credit_usage` | read (free, master key) | `POST /usage_stats/api_usage_stats` |

Notes that save you a support ticket:

- **People search returns no contact data.** Apollo's current
  `mixed_people/api_search` endpoint deliberately obfuscates last names and
  omits emails/phones. Feed the returned person `id` into
  `apollo_person_enrich` to get contact data (that is what costs credits).
- **Phone reveals are asynchronous.** `reveal_phone_number=true` requires a
  public HTTPS `webhookUrl`; Apollo POSTs the numbers there minutes later. The
  synchronous response carries a `request_id` — poll `apollo_webhook_result`
  with it if the callback is missed (results kept 30 days).
- **Master API key.** `apollo_people_search` and `apollo_credit_usage` require
  a *master* Apollo API key (Apollo returns 403 `API_INACCESSIBLE` otherwise).
- **No credit-balance API.** Apollo only exposes per-endpoint rate-limit usage;
  the remaining credit balance lives in the Apollo UI (Settings → Billing).
- **Field projection.** Every data tool accepts `fields[]` dot-paths to shrink
  responses; company search applies a slim default projection (pass `["*"]`
  for full records).

## Usage

```bash
npm install
npm run build

# stdio transport (Claude Desktop, local MCP clients)
APOLLO_API_KEY=... node dist/transports/stdio.js

# streamable HTTP transport on :3000/mcp
APOLLO_API_KEY=... MCP_HTTP_TOKEN=... node dist/transports/http.js
```

Configuration (see `.env.example`): `APOLLO_API_KEY` (required),
`APOLLO_TIMEOUT_MS`, `APOLLO_AUDIT_LOG` (JSONL audit trail; hashed targets,
never raw arguments or secrets), and for HTTP: `MCP_HTTP_HOST`, `PORT`,
`MCP_HTTP_TOKEN` (static bearer), `MCP_ALLOWED_ORIGINS`, `MCP_MAX_BODY_BYTES`.

There is also an embeddable gateway export (`mcp-server-apollo/gateway`) that
exposes the same tools as plain functions with JSON-schema definitions.

## Security

- The API key is read only from the server environment, sent only in the
  `x-api-key` header over HTTPS, and redacted from error messages and logs.
- Tool calls pass a policy allowlist; anything unlisted is denied.
- All tools are annotated read-only/non-destructive; credit-consuming tools
  state their cost in the description so agents confirm spend with the user.
- HTTP transport binds to loopback by default, validates `Origin`, caps body
  size, and supports a static bearer token for upstream auth proxies.
- Rate limits: HTTP 429 is retried with jittered backoff honouring
  `retry-after`; bulk enrichment runs at low bounded concurrency because
  Apollo limits `bulk_match` hard (documented 20/min).

## Development

```bash
npm run typecheck
npm test
npm run smoke:live   # needs a real APOLLO_API_KEY; uses ~1 credit
```

## License

Apache-2.0
