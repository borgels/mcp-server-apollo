# Changelog

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
