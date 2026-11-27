# mcp-server-apollo

MCP (Model Context Protocol) server for the [Apollo.io](https://www.apollo.io) B2B
discovery and enrichment API: company search, people search, contact
enrichment (emails/phones), organization firmographics, and API usage stats.

The server wraps Apollo's REST API with one account-level API key kept
server-side. The MCP server's own tools are read-only; the embeddable gateway
also covers the everyday CRM work (contacts, accounts, deals, tasks and
sequence enrollment) behind a host policy, and never deletes anything.

This is an independent, unofficial project. It is not developed, endorsed or supported by Apollo.io.

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
  with it if the callback is missed (results kept 30 days). Non-`https://`
  webhook URLs are rejected by both the MCP tools and the gateway export.
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
`APOLLO_TIMEOUT_MS` (1-600000, default 30000), `APOLLO_AUDIT_LOG` (JSONL audit
trail; hashed targets, never raw arguments or secrets).

HTTP transport:

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` (or `HOST`) | `127.0.0.1` | Bind address. |
| `PORT` | `3000` | Listen port (1-65535). |
| `MCP_HTTP_TOKEN` | unset | Bearer token required on `/mcp`; at least 32 printable ASCII characters. Required when binding to a non-loopback address or with `MCP_ALLOW_ANY_ORIGIN=true`. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Start without a token on a non-loopback bind anyway (only when access is restricted by other means). |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated exact `Origin` values allowed. Requests without `Origin` (server-to-server) are allowed. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any `Origin` (requires a token). |
| `MCP_ALLOWED_HOSTS` | see below | Comma-separated host names accepted in the `Host` header. By default a loopback bind only accepts localhost names and its bind address; other binds do not check `Host`. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body size. |
| `MCP_AUTH_FAILURE_LIMIT` | `20` | Failed authentication attempts per client address and window before further failures get HTTP 429; `0` disables. Requests with a valid token are never throttled. |
| `MCP_AUTH_FAILURE_WINDOW_MS` | `60000` | Window for the limit above. |

Invalid numeric or boolean values stop the server at startup with a message
naming the variable. `GET /healthz` answers `{"status":"ok"}` without
authentication, for container health checks.

## Embedding (`mcp-server-apollo/gateway`)

The gateway export is built for hosts that serve several teams from one
process and do their own per-user authorization:

```ts
import { createApolloGateway, apolloToolCatalog } from 'mcp-server-apollo/gateway';

const gateway = createApolloGateway({
  apiKey: teamApiKey,            // required; never read from the environment
  policy: { enableWrites: true }, // writes are off by default
});
const result = await gateway.callTool('search_contacts', { qKeywords: 'Jane' }, { caller: 'user-1' });
```

- It talks to `https://api.apollo.io` only and reads no `APOLLO_*` variable.
- `apolloToolCatalog` lists every tool with its risk level (`read` or
  `write`; none is `destructive`), the `broad` mark (no tool is broad) and
  every Apollo request it may make. The client refuses any other request.
- Errors are the server's own texts chosen by HTTP status. An error result
  carries `failure` (HTTP status, Apollo's request id when a response header
  gives one in the form of an id, the method and the path template), never
  Apollo's body.
- A key must be printable ASCII of at least 16 characters and may share no
  6-character piece with the server's own texts; every output is checked in
  its final form and withheld when it holds a piece of the key.

| Gateway tool | Risk | Apollo endpoint |
| --- | --- | --- |
| `search_capabilities` | read | — |
| `check_connection` | read | `GET /users/api_profile` |
| `companies_search` | read + 1 credit/page | `POST /mixed_companies/search` |
| `people_search` | read (master key) | `POST /mixed_people/api_search` |
| `person_enrich` | read + credits | `POST /people/match` |
| `people_bulk_enrich` | read + credits | `POST /people/bulk_match` |
| `org_enrich` | read + 1 credit | `GET /organizations/enrich` |
| `credit_usage` | read (usage needs a master key) | `GET /users/api_profile`, `POST /usage_stats/api_usage_stats` |
| `search_contacts`, `get_contact` | read | `POST /contacts/search`, `GET /contacts/{id}` |
| `search_accounts`, `get_account` | read | `POST /accounts/search`, `GET /accounts/{id}` |
| `search_deals`, `get_deal` | read | `GET /opportunities/search`, `GET /opportunities/{id}` |
| `search_tasks` | read | `POST /tasks/search` |
| `search_sequences` | read | `POST /emailer_campaigns/search` |
| `list_users` | read (master key) | `GET /users/search` |
| `list_email_accounts` | read | `GET /email_accounts` |
| `list_stages` | read | `GET /contact_stages`, `/account_stages`, `/opportunity_stages` |
| `create_contact`, `update_contact` | write | `POST /contacts`, `PATCH /contacts/{id}` |
| `set_contact_stage`, `set_contact_owner` | write | `POST /contacts/update_stages`, `/contacts/update_owners` |
| `create_account`, `update_account`, `set_account_owner` | write | `POST /accounts`, `PATCH /accounts/{id}`, `POST /accounts/update_owners` |
| `create_deal`, `update_deal` | write | `POST /opportunities`, `PATCH /opportunities/{id}` |
| `create_task`, `complete_task` | write | `POST /tasks`, `POST /tasks/{id}/complete` |
| `add_contacts_to_sequence` | write (the sequence then sends email) | `POST /emailer_campaigns/{id}/add_contact_ids` |

The owner of a contact or an account changes only through `set_contact_owner`
and `set_account_owner`; the create and update tools take no owner, so a host
can allow everyday edits without allowing a move to another user.

Nothing in the gateway deletes, merges, manages users or settings, or
reveals phone numbers (a reveal needs a public webhook that would receive
personal data outside the host). An Apollo key can be scoped to selected
endpoints or set as a master key, which reaches every endpoint; tools whose
endpoint the key cannot reach fail with HTTP 403.

## Security

- The API key is read only from the server environment, sent only in the
  `x-api-key` header over HTTPS, and redacted from error messages and logs.
- Tool calls pass a policy allowlist; anything unlisted is denied.
- All tools are annotated read-only/non-destructive; credit-consuming tools
  state their cost in the description so agents confirm spend with the user.
- HTTP transport binds to loopback by default, validates `Origin` and (on
  loopback binds) `Host`, caps body size, and refuses to start on a
  non-loopback address without `MCP_HTTP_TOKEN`.
- Requests to Apollo never follow redirects, so the API key is not re-sent
  to another location; error bodies are read up to 64 KB and shortened.
- Rate limits: HTTP 429 is retried with jittered backoff honouring
  `retry-after`; bulk enrichment runs at low bounded concurrency because
  Apollo limits `bulk_match` hard (documented 20/min).

## Security model

- The server uses one shared Apollo API key for every caller. Anyone who can
  call its tools acts with that key's access and credits.
- `MCP_HTTP_TOKEN` is a single shared secret that authenticates callers of
  the HTTP endpoint; it does not identify individual users. Per-user
  authentication and authorization belong in an identity-aware gateway or
  proxy in front of this server.
- Access to a tool is access to the data that tool can reach with the shared
  key; the policy allowlist limits which tools exist, not which records a
  caller may see.
- The HTTP server does not terminate TLS. Run it on loopback or a private
  network, behind a TLS-terminating proxy when traffic leaves the host.

## Development

```bash
npm run typecheck
npm test
npm run smoke:live   # needs a real APOLLO_API_KEY; uses ~1 credit
```

## License

The code is source-available under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2).

In plain words:

- **Allowed:** reading the code, running it, changing it, using it inside your own organisation (also commercially), using it for non-commercial education and research, and contributing changes back.
- **Not allowed:** making it, or something built from it, available to others as a commercial product or service that competes with it, for example a hosted service with the same functionality.
- **Becomes Apache-2.0:** each version is also licensed under the Apache License 2.0 from two years after it is released.
- **Earlier versions:** versions released before 0.3.0 were licensed under Apache-2.0 and remain so.

The terms in [LICENSE](LICENSE) are what apply; this summary does not replace them. See also [NOTICE](NOTICE).
