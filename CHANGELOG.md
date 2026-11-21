# Changelog

## 0.3.0 (2026-11-21)

- License changed from Apache-2.0 to the Functional Source License, Version 1.1,
  ALv2 Future License (FSL-1.1-ALv2). You may read, run, modify and use the code
  internally and contribute changes; offering it as a competing commercial
  product or service is not allowed. Each version becomes Apache-2.0 two years
  after its release. Versions released before 0.3.0 remain under Apache-2.0
  (see `NOTICE`).

## 0.2.0 (2026-11-16)

HTTP transport hardening, upstream client hardening and dependency updates.

- The HTTP transport refuses to start on a non-loopback bind address, or with
  `MCP_ALLOW_ANY_ORIGIN=true`, unless `MCP_HTTP_TOKEN` is set.
  `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` overrides this explicitly.
- `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters.
- `PORT`, `MCP_MAX_BODY_BYTES`, `APOLLO_TIMEOUT_MS` and boolean flags are
  validated at startup; invalid values stop the server instead of silently
  disabling a limit.
- Failed authentication is throttled per client address (HTTP 429 with
  `Retry-After`); valid tokens are never throttled. New variables
  `MCP_AUTH_FAILURE_LIMIT` (default 20, `0` disables) and
  `MCP_AUTH_FAILURE_WINDOW_MS` (default 60000).
- `Host` header check on loopback binds; new variable `MCP_ALLOWED_HOSTS`.
- HTTP 401 carries `WWW-Authenticate: Bearer`; invalid JSON gets HTTP 400 (JSON-RPC
  parse error) instead of 500; oversized bodies get 413 before being read.
- New unauthenticated `GET /healthz`; graceful shutdown on SIGTERM/SIGINT.
- Requests to Apollo use `redirect: 'manual'`: a redirect is reported as an
  error and the API key is never re-sent to another location.
- Error bodies are read up to 64 KB; upstream text in errors is redacted
  (including the configured key by value) before it is shortened, and error
  URLs no longer include the query string.
- The server reports the package version.
- Dependency updates (`@modelcontextprotocol/sdk` 1.32, `zod` 4.6) and
  overrides for patched transitive packages.

Upgrade notes: deployments that bind to `0.0.0.0` must set `MCP_HTTP_TOKEN`
(32+ characters) or the server exits at startup. Check that numeric variables
hold plain integers. A server bound to a loopback address behind a reverse
proxy that forwards the public `Host` header now answers 403 on `/mcp` until
that host name is listed in `MCP_ALLOWED_HOSTS`.

## 0.1.0 (2026-07-13)

Initial release.

- Tools: `apollo_search_capabilities`, `apollo_companies_search`,
  `apollo_people_search`, `apollo_person_enrich`, `apollo_people_bulk_enrich`,
  `apollo_org_enrich`, `apollo_webhook_result`, `apollo_credit_usage`.
- Company search preserves Apollo's `organizations` vs `accounts` split (CRM
  dedupe) and passes `pagination` through unchanged; slim default field
  projection with `fields[]` dot-path overrides on all data tools.
- Bulk people enrichment chunks into Apollo-sized `bulk_match` calls (10),
  fans out with bounded concurrency, retries HTTP 429 with jittered backoff,
  isolates per-item failures, and reports MCP progress notifications.
- Asynchronous phone reveals surfaced honestly: `webhookUrl` enforced,
  `request_id` returned, `apollo_webhook_result` poll tool included.
- Policy allowlist, JSONL audit log (hashed targets), secret redaction,
  stdio + streamable HTTP transports, embeddable gateway export.
